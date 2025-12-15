/**
 * OKX Data Exporter
 * 
 * Exports:
 * 1. Trade History - 成交記錄 (/api/v5/trade/fills-history)
 * 2. Bills History (Funding, PnL) - 資金變動 (/api/v5/account/bills-archive)
 * 3. Account Info - 帳戶資訊 (/api/v5/account/balance, /api/v5/account/positions)
 */

import crypto from 'crypto';
import https from 'https';
import fs from 'fs';
import path from 'path';
import {
    ExchangeConfig,
    formatSymbol,
    UnifiedExecution,
    UnifiedWalletTransaction,
    UnifiedAccountSummary,
    ImportResult
} from './exchange_types';

const OKX_API_BASE = 'www.okx.com';
const SAT_TO_BTC = 100000000;

// Rate limiting settings
const REQUEST_DELAY = 200; // 200ms between requests (OKX rate limit is 20 req/2s)

// Check if CSV file exists and has data
function csvExists(filename: string): boolean {
    const filePath = path.join(process.cwd(), filename);
    if (!fs.existsSync(filePath)) return false;
    const stats = fs.statSync(filePath);
    return stats.size > 100;
}

interface OkxRequestParams {
    [key: string]: string | number | undefined;
}

// Sleep helper
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Get instrument config based on instType
function getInstTypeConfig(instType: 'SWAP' | 'FUTURES' | 'MARGIN' | 'ALL' | undefined): { instType: string; instIds: string[] }[] {
    const type = instType || 'SWAP';

    if (type === 'ALL') {
        return [
            { instType: 'SWAP', instIds: [] },
            { instType: 'FUTURES', instIds: [] },
            { instType: 'MARGIN', instIds: [] },
        ];
    }

    return [{ instType: type, instIds: [] }];
}

// Generate OKX signature
function generateOkxSignature(
    timestamp: string,
    method: string,
    requestPath: string,
    body: string,
    secretKey: string
): string {
    const preHash = timestamp + method.toUpperCase() + requestPath + body;
    const signature = crypto.createHmac('sha256', secretKey).update(preHash).digest('base64');
    return signature;
}

// Helper function to make signed OKX API requests
async function okxRequest(
    apiKey: string,
    apiSecret: string,
    passphrase: string,
    method: string,
    endpoint: string,
    params: OkxRequestParams = {}
): Promise<any> {
    return new Promise((resolve, reject) => {
        const timestamp = new Date().toISOString();

        // Build query string for GET requests
        let queryString = '';
        let body = '';

        if (method === 'GET' && Object.keys(params).length > 0) {
            queryString = '?' + Object.entries(params)
                .filter(([, v]) => v !== undefined)
                .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
                .join('&');
        } else if (method === 'POST') {
            body = JSON.stringify(params);
        }

        const requestPath = endpoint + queryString;
        const signature = generateOkxSignature(timestamp, method, requestPath, body, apiSecret);

        const options = {
            hostname: OKX_API_BASE,
            port: 443,
            path: requestPath,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'OK-ACCESS-KEY': apiKey,
                'OK-ACCESS-SIGN': signature,
                'OK-ACCESS-TIMESTAMP': timestamp,
                'OK-ACCESS-PASSPHRASE': passphrase,
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.code && json.code !== '0') {
                        reject(new Error(`OKX API Error ${json.code}: ${json.msg}`));
                    } else {
                        resolve(json);
                    }
                } catch (e) {
                    reject(new Error(`Parse error: ${data}`));
                }
            });
        });

        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// Export OKX Trades (fills history)
async function exportOkxTrades(config: ExchangeConfig, forceRefetch: boolean = false): Promise<UnifiedExecution[]> {
    const csvFile = 'okx_executions.csv';

    if (!forceRefetch && csvExists(csvFile)) {
        console.log('\n📊 OKX Trades: Using existing CSV (skip fetch)');
        return [];
    }

    console.log('\n📊 Exporting OKX Trade History...');

    const { apiKey, apiSecret, passphrase, startDate, endDate } = config;
    if (!passphrase) {
        throw new Error('OKX requires a passphrase');
    }

    const allExecutions: UnifiedExecution[] = [];
    const instTypeConfigs = getInstTypeConfig(config.okxInstType);

    const startTimeMs = new Date(startDate).getTime();
    const endTimeMs = new Date(endDate).getTime();

    for (const { instType } of instTypeConfigs) {
        console.log(`   Processing ${instType}...`);
        let totalCount = 0;
        let after = '';
        let hasMore = true;

        while (hasMore) {
            await sleep(REQUEST_DELAY);

            try {
                const params: OkxRequestParams = {
                    instType,
                    begin: startTimeMs.toString(),
                    end: endTimeMs.toString(),
                    limit: 100,
                };

                if (after) {
                    params.after = after;
                }

                const response = await okxRequest(apiKey, apiSecret, passphrase, 'GET', '/api/v5/trade/fills-history', params);

                if (response.data && response.data.length > 0) {
                    const fills = response.data;

                    for (const fill of fills) {
                        const side: 'Buy' | 'Sell' = fill.side === 'buy' ? 'Buy' : 'Sell';
                        const qty = parseFloat(fill.fillSz);
                        const price = parseFloat(fill.fillPx);
                        const fee = parseFloat(fill.fee || '0');

                        allExecutions.push({
                            execID: fill.tradeId || fill.billId,
                            orderID: fill.ordId,
                            symbol: fill.instId,
                            displaySymbol: formatSymbol(fill.instId, 'okx'),
                            side,
                            lastQty: qty,
                            lastPx: price,
                            execType: 'Trade',
                            ordType: fill.ordType || 'limit',
                            ordStatus: 'Filled',
                            execCost: Math.round(qty * price * SAT_TO_BTC),
                            execComm: Math.round(Math.abs(fee) * SAT_TO_BTC),
                            timestamp: new Date(parseInt(fill.ts)).toISOString(),
                            text: `posSide:${fill.posSide}|execType:${fill.execType}`,
                            exchange: 'okx',
                        });

                        after = fill.billId;
                    }

                    totalCount += fills.length;
                    hasMore = fills.length === 100;
                } else {
                    hasMore = false;
                }

                process.stdout.write(`\r   ${instType}: ${totalCount} trades    `);

            } catch (error: any) {
                if (error.message.includes('429') || error.message.includes('50011')) {
                    console.log(`\n   ⚠️ Rate limited, waiting 30s...`);
                    await sleep(30000);
                } else {
                    console.error(`\n   ⚠️ ${instType} error: ${error.message}`);
                    hasMore = false;
                }
            }
        }

        console.log(`\n   ✅ ${instType}: ${totalCount} trades total`);
    }

    return allExecutions;
}

// Export OKX Closed Positions History
async function exportOkxPositionsHistory(config: ExchangeConfig, forceRefetch: boolean = false): Promise<any[]> {
    const csvFile = 'okx_positions_history.csv';

    if (!forceRefetch && csvExists(csvFile)) {
        console.log('\n📈 OKX Positions History: Using existing CSV (skip fetch)');
        return [];
    }

    console.log('\n📈 Exporting OKX Closed Positions History...');

    const { apiKey, apiSecret, passphrase } = config;
    if (!passphrase) {
        throw new Error('OKX requires a passphrase');
    }

    const allPositions: any[] = [];
    const instTypeConfigs = getInstTypeConfig(config.okxInstType);

    for (const { instType } of instTypeConfigs) {
        console.log(`   Processing ${instType}...`);
        let totalCount = 0;
        let after = '';
        let hasMore = true;

        while (hasMore) {
            await sleep(REQUEST_DELAY);

            try {
                const params: OkxRequestParams = {
                    instType,
                    limit: 100,
                };

                if (after) {
                    params.after = after;
                }

                const response = await okxRequest(apiKey, apiSecret, passphrase, 'GET', '/api/v5/account/positions-history', params);

                if (response.data && response.data.length > 0) {
                    const positions = response.data;

                    for (const pos of positions) {
                        allPositions.push({
                            posId: pos.posId,
                            instId: pos.instId,
                            instType: pos.instType,
                            mgnMode: pos.mgnMode,
                            direction: pos.direction, // long/short
                            lever: pos.lever,
                            openAvgPx: parseFloat(pos.openAvgPx || '0'),
                            closeAvgPx: parseFloat(pos.closeAvgPx || '0'),
                            closeTotalPos: parseFloat(pos.closeTotalPos || '0'),
                            realizedPnl: parseFloat(pos.realizedPnl || '0'),
                            pnl: parseFloat(pos.pnl || '0'),
                            fee: parseFloat(pos.fee || '0'),
                            fundingFee: parseFloat(pos.fundingFee || '0'),
                            liqPenalty: parseFloat(pos.liqPenalty || '0'),
                            cTime: new Date(parseInt(pos.cTime)).toISOString(),
                            uTime: new Date(parseInt(pos.uTime)).toISOString(),
                            openTime: pos.openTime ? new Date(parseInt(pos.openTime)).toISOString() : '',
                            closeTime: pos.closeTime ? new Date(parseInt(pos.closeTime)).toISOString() : '',
                            ccy: pos.ccy,
                        });

                        after = pos.posId;
                    }

                    totalCount += positions.length;
                    hasMore = positions.length === 100;
                } else {
                    hasMore = false;
                }

                process.stdout.write(`\r   ${instType}: ${totalCount} positions    `);

            } catch (error: any) {
                if (error.message.includes('429') || error.message.includes('50011')) {
                    console.log(`\n   ⚠️ Rate limited, waiting 30s...`);
                    await sleep(30000);
                } else {
                    console.error(`\n   ⚠️ ${instType} positions error: ${error.message}`);
                    hasMore = false;
                }
            }
        }

        console.log(`\n   ✅ ${instType}: ${totalCount} closed positions total`);
    }

    return allPositions;
}
async function exportOkxBills(config: ExchangeConfig, forceRefetch: boolean = false): Promise<UnifiedWalletTransaction[]> {
    const csvFile = 'okx_wallet_history.csv';

    if (!forceRefetch && csvExists(csvFile)) {
        console.log('\n💰 OKX Bills: Using existing CSV (skip fetch)');
        return [];
    }

    console.log('\n💰 Exporting OKX Bills History...');

    const { apiKey, apiSecret, passphrase, startDate, endDate } = config;
    if (!passphrase) {
        throw new Error('OKX requires a passphrase');
    }

    const allTransactions: UnifiedWalletTransaction[] = [];
    const instTypeConfigs = getInstTypeConfig(config.okxInstType);
    const billTypes = ['2', '8']; // Trade and Funding Fee

    const startTimeMs = new Date(startDate).getTime();
    const endTimeMs = new Date(endDate).getTime();

    for (const { instType } of instTypeConfigs) {
        for (const type of billTypes) {
            const typeName = type === '2' ? 'Trade' : 'Funding';
            console.log(`   Processing ${instType} ${typeName}...`);
            let typeCount = 0;
            let after = '';
            let hasMore = true;

            while (hasMore) {
                await sleep(REQUEST_DELAY);

                try {
                    const params: OkxRequestParams = {
                        instType,
                        type,
                        begin: startTimeMs.toString(),
                        end: endTimeMs.toString(),
                        limit: 100,
                    };

                    if (after) {
                        params.after = after;
                    }

                    const response = await okxRequest(apiKey, apiSecret, passphrase, 'GET', '/api/v5/account/bills-archive', params);

                    if (response.data && response.data.length > 0) {
                        const bills = response.data;

                        for (const bill of bills) {
                            const amount = parseFloat(bill.pnl || bill.balChg || '0');
                            const fee = parseFloat(bill.fee || '0');

                            let transactType: UnifiedWalletTransaction['transactType'];
                            if (type === '8') {
                                transactType = 'Funding';
                            } else if (amount > 0) {
                                transactType = 'RealisedPNL';
                            } else {
                                transactType = 'Commission';
                            }

                            allTransactions.push({
                                transactID: bill.billId,
                                account: bill.instId || 'USDT',
                                currency: bill.ccy || 'USDT',
                                transactType,
                                amount: Math.round(amount * SAT_TO_BTC),
                                fee: Math.round(Math.abs(fee) * SAT_TO_BTC),
                                transactStatus: 'Completed',
                                address: '',
                                tx: '',
                                text: bill.notes || '',
                                timestamp: new Date(parseInt(bill.ts)).toISOString(),
                                walletBalance: 0,
                                marginBalance: null,
                                exchange: 'okx',
                            });

                            after = bill.billId;
                        }

                        typeCount += bills.length;
                        hasMore = bills.length === 100;
                    } else {
                        hasMore = false;
                    }

                } catch (error: any) {
                    if (error.message.includes('429') || error.message.includes('50011')) {
                        console.log(`\n   ⚠️ Rate limited, waiting 30s...`);
                        await sleep(30000);
                    } else {
                        console.error(`\n   ⚠️ ${instType} ${typeName} error: ${error.message}`);
                        hasMore = false;
                    }
                }
            }

            console.log(`   ✅ ${instType} ${typeName}: ${typeCount} records`);
        }
    }

    // Sort and calculate balance
    allTransactions.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    let runningBalance = 0;
    for (const tx of allTransactions) {
        runningBalance += tx.amount;
        tx.walletBalance = runningBalance;
    }

    return allTransactions;
}

// Get OKX Account Info
async function getOkxAccountInfo(config: ExchangeConfig): Promise<UnifiedAccountSummary> {
    console.log('\n👤 Fetching OKX Account Info...');

    const { apiKey, apiSecret, passphrase, okxInstType } = config;
    if (!passphrase) {
        throw new Error('OKX requires a passphrase');
    }

    try {
        const balanceResponse = await okxRequest(apiKey, apiSecret, passphrase, 'GET', '/api/v5/account/balance', {});
        const balanceData = balanceResponse.data?.[0] || {};

        await sleep(REQUEST_DELAY);

        // Get positions for selected instType
        const instType = okxInstType || 'SWAP';
        const positionsResponse = await okxRequest(apiKey, apiSecret, passphrase, 'GET', '/api/v5/account/positions',
            instType === 'ALL' ? {} : { instType }
        );
        const positionsData = positionsResponse.data || [];

        const totalEq = parseFloat(balanceData.totalEq || '0');
        const imr = parseFloat(balanceData.imr || '0');
        const upl = parseFloat(balanceData.upl || '0');

        const summary: UnifiedAccountSummary = {
            exportDate: new Date().toISOString(),
            exchange: 'okx',
            user: {
                id: 'okx_user',
                username: 'OKX',
            },
            wallet: {
                walletBalance: totalEq,
                marginBalance: totalEq,
                availableMargin: totalEq - imr,
                unrealisedPnl: upl,
                realisedPnl: 0,
                currency: 'USDT',
            },
            positions: positionsData
                .filter((p: any) => parseFloat(p.pos) !== 0)
                .map((p: any) => ({
                    symbol: p.instId,
                    displaySymbol: formatSymbol(p.instId, 'okx'),
                    currentQty: parseFloat(p.pos),
                    avgEntryPrice: parseFloat(p.avgPx || '0'),
                    unrealisedPnl: parseFloat(p.upl || '0'),
                    liquidationPrice: parseFloat(p.liqPx) || null,
                })),
        };

        console.log(`   ✅ Total Equity: ${(summary.wallet.walletBalance ?? 0).toFixed(2)} USDT`);
        console.log(`   ✅ Open Positions: ${summary.positions.length}`);

        return summary;
    } catch (error: any) {
        console.error(`   ❌ Account info failed: ${error.message}`);
        throw error;
    }
}

// Main export function
export async function exportOkxData(config: ExchangeConfig): Promise<ImportResult> {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('                   OKX Data Export');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`Date Range: ${config.startDate} to ${config.endDate}`);
    console.log(`Instrument Type: ${config.okxInstType || 'SWAP'}`);
    console.log('═══════════════════════════════════════════════════════════');

    const startTime = Date.now();

    try {
        const forceRefetch = config.forceRefetch || false;
        const accountSummary = await getOkxAccountInfo(config);
        const executions = await exportOkxTrades(config, forceRefetch);
        const positionsHistory = await exportOkxPositionsHistory(config, forceRefetch);
        const walletHistory = await exportOkxBills(config, forceRefetch);

        const baseDir = process.cwd();

        if (executions.length > 0) {
            const execPath = path.join(baseDir, 'okx_executions.csv');
            const execHeaders = 'execID,orderID,symbol,side,lastQty,lastPx,execType,ordType,ordStatus,execCost,execComm,timestamp,text\n';
            const execRows = executions.map(e => [
                e.execID, e.orderID, e.symbol, e.side, e.lastQty, e.lastPx,
                e.execType, e.ordType, e.ordStatus, e.execCost, e.execComm, e.timestamp,
                `"${(e.text || '').replace(/"/g, '""')}"`
            ].join(',')).join('\n');
            fs.writeFileSync(execPath, execHeaders + execRows);
        }

        // Save positions history
        if (positionsHistory.length > 0) {
            const posPath = path.join(baseDir, 'okx_positions_history.csv');
            const posHeaders = 'posId,instId,instType,mgnMode,direction,lever,openAvgPx,closeAvgPx,closeTotalPos,realizedPnl,pnl,fee,fundingFee,liqPenalty,openTime,closeTime,ccy\n';
            const posRows = positionsHistory.map(p => [
                p.posId, p.instId, p.instType, p.mgnMode, p.direction, p.lever,
                p.openAvgPx, p.closeAvgPx, p.closeTotalPos, p.realizedPnl, p.pnl,
                p.fee, p.fundingFee, p.liqPenalty, p.openTime, p.closeTime, p.ccy
            ].join(',')).join('\n');
            fs.writeFileSync(posPath, posHeaders + posRows);
        }

        if (walletHistory.length > 0) {
            const walletPath = path.join(baseDir, 'okx_wallet_history.csv');
            const walletHeaders = 'transactID,account,currency,transactType,amount,fee,transactStatus,address,tx,text,timestamp,walletBalance,marginBalance\n';
            const walletRows = walletHistory.map(w => [
                w.transactID, w.account, w.currency, w.transactType, w.amount, w.fee,
                w.transactStatus, w.address, w.tx, `"${(w.text || '').replace(/"/g, '""')}"`,
                w.timestamp, w.walletBalance, w.marginBalance || ''
            ].join(',')).join('\n');
            fs.writeFileSync(walletPath, walletHeaders + walletRows);
        }

        const summaryPath = path.join(baseDir, 'okx_account_summary.json');
        fs.writeFileSync(summaryPath, JSON.stringify(accountSummary, null, 2));

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        let finalExecutions = executions.length;
        let finalWallet = walletHistory.length;

        if (executions.length === 0 && csvExists('okx_executions.csv')) {
            const content = fs.readFileSync(path.join(process.cwd(), 'okx_executions.csv'), 'utf-8');
            finalExecutions = content.split('\n').length - 2;
        }
        if (walletHistory.length === 0 && csvExists('okx_wallet_history.csv')) {
            const content = fs.readFileSync(path.join(process.cwd(), 'okx_wallet_history.csv'), 'utf-8');
            finalWallet = content.split('\n').length - 2;
        }

        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('                    Export Complete!');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`   Executions: ${finalExecutions}`);
        console.log(`   Bills:      ${finalWallet}`);
        console.log(`   Duration:   ${duration}s`);
        console.log('═══════════════════════════════════════════════════════════');

        return {
            success: true,
            message: `OKX data ready: ${finalExecutions} trades, ${finalWallet} bills`,
            stats: {
                executions: finalExecutions,
                trades: finalExecutions,
                orders: 0,
                walletHistory: finalWallet,
            }
        };
    } catch (error: any) {
        console.error('Export failed:', error.message);
        return {
            success: false,
            message: 'Export failed',
            error: error.message,
        };
    }
}

// Test connection
export async function testOkxConnection(apiKey: string, apiSecret: string, passphrase: string): Promise<{ success: boolean; message: string }> {
    try {
        const response = await okxRequest(apiKey, apiSecret, passphrase, 'GET', '/api/v5/account/balance', {});
        const totalEq = response.data?.[0]?.totalEq || '0';
        return {
            success: true,
            message: `Connected! Total Equity: ${parseFloat(totalEq).toFixed(2)} USDT`
        };
    } catch (error: any) {
        return {
            success: false,
            message: error.message
        };
    }
}

// ============================================================================
// STREAMING VERSION - With real-time progress callbacks
// ============================================================================

type LogCallback = (message: string, type?: 'info' | 'success' | 'error' | 'warning' | 'progress', progress?: number) => Promise<void>;

export async function exportOkxDataWithProgress(
    config: ExchangeConfig,
    log: LogCallback
): Promise<ImportResult> {
    const startTime = Date.now();
    const forceRefetch = config.forceRefetch || false;
    const instType = config.okxInstType || 'SWAP';

    await log('═══════════════════════════════════════════════════════════', 'info');
    await log('                   OKX Data Export', 'info');
    await log('═══════════════════════════════════════════════════════════', 'info');
    await log(`Date Range: ${config.startDate} to ${config.endDate}`, 'info');
    await log(`Instrument Type: ${instType}`, 'info');
    await log('═══════════════════════════════════════════════════════════', 'info');

    try {
        const { apiKey, apiSecret, passphrase } = config;
        if (!passphrase) {
            throw new Error('OKX requires a passphrase');
        }

        await log('👤 Fetching account info...', 'info');
        const accountSummary = await getOkxAccountInfo(config);
        await log(`✓ Total Equity: ${(accountSummary.wallet.walletBalance ?? 0).toFixed(2)} USDT`, 'success');
        await log(`✓ Open Positions: ${accountSummary.positions.length}`, 'success');

        await log('', 'info');
        await log('📊 Fetching trade history...', 'info');
        const executions = await exportOkxTradesWithProgress(config, forceRefetch, log);

        await log('', 'info');
        await log('📈 Fetching closed positions history...', 'info');
        const positionsHistory = await exportOkxPositionsHistoryWithProgress(config, forceRefetch, log);

        await log('', 'info');
        await log('💰 Fetching bills history...', 'info');
        const walletHistory = await exportOkxBillsWithProgress(config, forceRefetch, log);

        await log('', 'info');
        await log('💾 Saving data files...', 'info');

        const baseDir = process.cwd();

        if (executions.length > 0) {
            const execPath = path.join(baseDir, 'okx_executions.csv');
            const execHeaders = 'execID,orderID,symbol,side,lastQty,lastPx,execType,ordType,ordStatus,execCost,execComm,timestamp,text\n';
            const execRows = executions.map(e => [
                e.execID, e.orderID, e.symbol, e.side, e.lastQty, e.lastPx,
                e.execType, e.ordType, e.ordStatus, e.execCost, e.execComm, e.timestamp,
                `"${(e.text || '').replace(/"/g, '""')}"`
            ].join(',')).join('\n');
            fs.writeFileSync(execPath, execHeaders + execRows);
            await log(`✓ Saved executions: ${executions.length} records`, 'success');
        }

        // Save positions history
        if (positionsHistory.length > 0) {
            const posPath = path.join(baseDir, 'okx_positions_history.csv');
            const posHeaders = 'posId,instId,instType,mgnMode,direction,lever,openAvgPx,closeAvgPx,closeTotalPos,realizedPnl,pnl,fee,fundingFee,liqPenalty,openTime,closeTime,ccy\n';
            const posRows = positionsHistory.map((p: any) => [
                p.posId, p.instId, p.instType, p.mgnMode, p.direction, p.lever,
                p.openAvgPx, p.closeAvgPx, p.closeTotalPos, p.realizedPnl, p.pnl,
                p.fee, p.fundingFee, p.liqPenalty, p.openTime, p.closeTime, p.ccy
            ].join(',')).join('\n');
            fs.writeFileSync(posPath, posHeaders + posRows);
            await log(`✓ Saved positions history: ${positionsHistory.length} records`, 'success');
        }

        if (walletHistory.length > 0) {
            const walletPath = path.join(baseDir, 'okx_wallet_history.csv');
            const walletHeaders = 'transactID,account,currency,transactType,amount,fee,transactStatus,address,tx,text,timestamp,walletBalance,marginBalance\n';
            const walletRows = walletHistory.map(w => [
                w.transactID, w.account, w.currency, w.transactType, w.amount, w.fee,
                w.transactStatus, w.address, w.tx, `"${(w.text || '').replace(/"/g, '""')}"`,
                w.timestamp, w.walletBalance, w.marginBalance || ''
            ].join(',')).join('\n');
            fs.writeFileSync(walletPath, walletHeaders + walletRows);
            await log(`✓ Saved wallet history: ${walletHistory.length} records`, 'success');
        }

        const summaryPath = path.join(baseDir, 'okx_account_summary.json');
        fs.writeFileSync(summaryPath, JSON.stringify(accountSummary, null, 2));
        await log('✓ Saved account summary', 'success');

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        let finalExecutions = executions.length;
        let finalWallet = walletHistory.length;

        if (executions.length === 0 && csvExists('okx_executions.csv')) {
            const content = fs.readFileSync(path.join(process.cwd(), 'okx_executions.csv'), 'utf-8');
            finalExecutions = content.split('\n').length - 2;
        }
        if (walletHistory.length === 0 && csvExists('okx_wallet_history.csv')) {
            const content = fs.readFileSync(path.join(process.cwd(), 'okx_wallet_history.csv'), 'utf-8');
            finalWallet = content.split('\n').length - 2;
        }

        await log('', 'info');
        await log('═══════════════════════════════════════════════════════════', 'success');
        await log('                    ✅ Export Complete!', 'success');
        await log('═══════════════════════════════════════════════════════════', 'success');
        await log(`   Executions: ${finalExecutions}`, 'success');
        await log(`   Bills:      ${finalWallet}`, 'success');
        await log(`   Duration:   ${duration}s`, 'success');

        return {
            success: true,
            message: `OKX data ready: ${finalExecutions} trades, ${finalWallet} bills`,
            stats: {
                executions: finalExecutions,
                trades: finalExecutions,
                orders: 0,
                walletHistory: finalWallet,
            }
        };
    } catch (error: any) {
        await log(`❌ Export failed: ${error.message}`, 'error');
        return {
            success: false,
            message: 'Export failed',
            error: error.message,
        };
    }
}

// Trades with progress
async function exportOkxTradesWithProgress(
    config: ExchangeConfig,
    forceRefetch: boolean,
    log: LogCallback
): Promise<UnifiedExecution[]> {
    const csvFile = 'okx_executions.csv';

    if (!forceRefetch && csvExists(csvFile)) {
        await log('   Using existing CSV (skip fetch)', 'info');
        return [];
    }

    const { apiKey, apiSecret, passphrase, startDate, endDate } = config;
    if (!passphrase) {
        throw new Error('OKX requires a passphrase');
    }

    const allExecutions: UnifiedExecution[] = [];
    const instTypeConfigs = getInstTypeConfig(config.okxInstType);

    const startTimeMs = new Date(startDate).getTime();
    const endTimeMs = new Date(endDate).getTime();

    for (const { instType } of instTypeConfigs) {
        await log(`   Processing ${instType}...`, 'info');
        let totalCount = 0;
        let after = '';
        let hasMore = true;

        while (hasMore) {
            await sleep(REQUEST_DELAY);

            try {
                const params: OkxRequestParams = {
                    instType,
                    begin: startTimeMs.toString(),
                    end: endTimeMs.toString(),
                    limit: 100,
                };

                if (after) {
                    params.after = after;
                }

                const response = await okxRequest(apiKey, apiSecret, passphrase, 'GET', '/api/v5/trade/fills-history', params);

                if (response.data && response.data.length > 0) {
                    const fills = response.data;

                    for (const fill of fills) {
                        const side: 'Buy' | 'Sell' = fill.side === 'buy' ? 'Buy' : 'Sell';
                        const qty = parseFloat(fill.fillSz);
                        const price = parseFloat(fill.fillPx);
                        const fee = parseFloat(fill.fee || '0');

                        allExecutions.push({
                            execID: fill.tradeId || fill.billId,
                            orderID: fill.ordId,
                            symbol: fill.instId,
                            displaySymbol: formatSymbol(fill.instId, 'okx'),
                            side,
                            lastQty: qty,
                            lastPx: price,
                            execType: 'Trade',
                            ordType: fill.ordType || 'limit',
                            ordStatus: 'Filled',
                            execCost: Math.round(qty * price * SAT_TO_BTC),
                            execComm: Math.round(Math.abs(fee) * SAT_TO_BTC),
                            timestamp: new Date(parseInt(fill.ts)).toISOString(),
                            text: `posSide:${fill.posSide}|execType:${fill.execType}`,
                            exchange: 'okx',
                        });

                        after = fill.billId;
                    }

                    totalCount += fills.length;
                    hasMore = fills.length === 100;
                } else {
                    hasMore = false;
                }

            } catch (error: any) {
                if (error.message.includes('429') || error.message.includes('50011')) {
                    await log(`   ⚠️ Rate limited, waiting 30s...`, 'warning');
                    await sleep(30000);
                } else {
                    await log(`   ⚠️ ${instType} error: ${error.message}`, 'warning');
                    hasMore = false;
                }
            }
        }

        await log(`   ✓ ${instType}: ${totalCount} trades`, 'success');
    }

    return allExecutions;
}

// Positions history with progress
async function exportOkxPositionsHistoryWithProgress(
    config: ExchangeConfig,
    forceRefetch: boolean,
    log: LogCallback
): Promise<any[]> {
    const csvFile = 'okx_positions_history.csv';

    if (!forceRefetch && csvExists(csvFile)) {
        await log('   Using existing CSV (skip fetch)', 'info');
        return [];
    }

    const { apiKey, apiSecret, passphrase } = config;
    if (!passphrase) {
        throw new Error('OKX requires a passphrase');
    }

    const allPositions: any[] = [];
    const instTypeConfigs = getInstTypeConfig(config.okxInstType);

    for (const { instType } of instTypeConfigs) {
        await log(`   Processing ${instType}...`, 'info');
        let totalCount = 0;
        let after = '';
        let hasMore = true;

        while (hasMore) {
            await sleep(REQUEST_DELAY);

            try {
                const params: OkxRequestParams = {
                    instType,
                    limit: 100,
                };

                if (after) {
                    params.after = after;
                }

                const response = await okxRequest(apiKey, apiSecret, passphrase, 'GET', '/api/v5/account/positions-history', params);

                if (response.data && response.data.length > 0) {
                    const positions = response.data;

                    for (const pos of positions) {
                        allPositions.push({
                            posId: pos.posId,
                            instId: pos.instId,
                            instType: pos.instType,
                            mgnMode: pos.mgnMode,
                            direction: pos.direction,
                            lever: pos.lever,
                            openAvgPx: parseFloat(pos.openAvgPx || '0'),
                            closeAvgPx: parseFloat(pos.closeAvgPx || '0'),
                            closeTotalPos: parseFloat(pos.closeTotalPos || '0'),
                            realizedPnl: parseFloat(pos.realizedPnl || '0'),
                            pnl: parseFloat(pos.pnl || '0'),
                            fee: parseFloat(pos.fee || '0'),
                            fundingFee: parseFloat(pos.fundingFee || '0'),
                            liqPenalty: parseFloat(pos.liqPenalty || '0'),
                            cTime: new Date(parseInt(pos.cTime)).toISOString(),
                            uTime: new Date(parseInt(pos.uTime)).toISOString(),
                            openTime: pos.openTime ? new Date(parseInt(pos.openTime)).toISOString() : '',
                            closeTime: pos.closeTime ? new Date(parseInt(pos.closeTime)).toISOString() : '',
                            ccy: pos.ccy,
                        });

                        after = pos.posId;
                    }

                    totalCount += positions.length;
                    hasMore = positions.length === 100;
                } else {
                    hasMore = false;
                }

            } catch (error: any) {
                if (error.message.includes('429') || error.message.includes('50011')) {
                    await log(`   ⚠️ Rate limited, waiting 30s...`, 'warning');
                    await sleep(30000);
                } else {
                    await log(`   ⚠️ ${instType} positions error: ${error.message}`, 'warning');
                    hasMore = false;
                }
            }
        }

        await log(`   ✓ ${instType}: ${totalCount} closed positions`, 'success');
    }

    return allPositions;
}

// Bills with progress
async function exportOkxBillsWithProgress(
    config: ExchangeConfig,
    forceRefetch: boolean,
    log: LogCallback
): Promise<UnifiedWalletTransaction[]> {
    const csvFile = 'okx_wallet_history.csv';

    if (!forceRefetch && csvExists(csvFile)) {
        await log('   Using existing CSV (skip fetch)', 'info');
        return [];
    }

    const { apiKey, apiSecret, passphrase, startDate, endDate } = config;
    if (!passphrase) {
        throw new Error('OKX requires a passphrase');
    }

    const allTransactions: UnifiedWalletTransaction[] = [];
    const instTypeConfigs = getInstTypeConfig(config.okxInstType);
    const billTypes = ['2', '8'];

    const startTimeMs = new Date(startDate).getTime();
    const endTimeMs = new Date(endDate).getTime();

    for (const { instType } of instTypeConfigs) {
        for (const type of billTypes) {
            const typeName = type === '2' ? 'Trade' : 'Funding';
            await log(`   Processing ${instType} ${typeName}...`, 'info');
            let typeCount = 0;
            let after = '';
            let hasMore = true;

            while (hasMore) {
                await sleep(REQUEST_DELAY);

                try {
                    const params: OkxRequestParams = {
                        instType,
                        type,
                        begin: startTimeMs.toString(),
                        end: endTimeMs.toString(),
                        limit: 100,
                    };

                    if (after) {
                        params.after = after;
                    }

                    const response = await okxRequest(apiKey, apiSecret, passphrase, 'GET', '/api/v5/account/bills-archive', params);

                    if (response.data && response.data.length > 0) {
                        const bills = response.data;

                        for (const bill of bills) {
                            const amount = parseFloat(bill.pnl || bill.balChg || '0');
                            const fee = parseFloat(bill.fee || '0');

                            let transactType: UnifiedWalletTransaction['transactType'];
                            if (type === '8') {
                                transactType = 'Funding';
                            } else if (amount > 0) {
                                transactType = 'RealisedPNL';
                            } else {
                                transactType = 'Commission';
                            }

                            allTransactions.push({
                                transactID: bill.billId,
                                account: bill.instId || 'USDT',
                                currency: bill.ccy || 'USDT',
                                transactType,
                                amount: Math.round(amount * SAT_TO_BTC),
                                fee: Math.round(Math.abs(fee) * SAT_TO_BTC),
                                transactStatus: 'Completed',
                                address: '',
                                tx: '',
                                text: bill.notes || '',
                                timestamp: new Date(parseInt(bill.ts)).toISOString(),
                                walletBalance: 0,
                                marginBalance: null,
                                exchange: 'okx',
                            });

                            after = bill.billId;
                        }

                        typeCount += bills.length;
                        hasMore = bills.length === 100;
                    } else {
                        hasMore = false;
                    }

                } catch (error: any) {
                    if (error.message.includes('429') || error.message.includes('50011')) {
                        await log(`   ⚠️ Rate limited, waiting 30s...`, 'warning');
                        await sleep(30000);
                    } else {
                        await log(`   ⚠️ ${instType} ${typeName} error: ${error.message}`, 'warning');
                        hasMore = false;
                    }
                }
            }

            await log(`   ✓ ${instType} ${typeName}: ${typeCount} records`, 'success');
        }
    }

    // Sort and calculate balance
    allTransactions.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    let runningBalance = 0;
    for (const tx of allTransactions) {
        runningBalance += tx.amount;
        tx.walletBalance = runningBalance;
    }

    return allTransactions;
}
