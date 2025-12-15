/**
 * Bybit Data Exporter
 * 
 * Exports:
 * 1. Trade History - 成交記錄 (/v5/execution/list)
 * 2. Wallet History - 資金變動 (/v5/account/transaction-log)
 * 3. Account Info - 帳戶資訊 (/v5/account/wallet-balance)
 */

import * as https from 'https';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    ExchangeConfig,
    UnifiedExecution,
    UnifiedWalletTransaction,
    UnifiedAccountSummary,
    ImportResult,
    formatSymbol
} from './exchange_types';

const BYBIT_API_BASE = 'api.bybit.com';
const REQUEST_DELAY = 200; // 200ms between requests

// Check if CSV file exists and has data
function csvExists(filename: string): boolean {
    if (fs.existsSync(filename)) {
        const content = fs.readFileSync(filename, 'utf-8').trim();
        const lines = content.split('\n');
        return lines.length > 1; // Has header + at least one data row
    }
    return false;
}

interface BybitRequestParams {
    [key: string]: string | number | undefined;
}

// Sleep helper
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Generate Bybit signature (HMAC-SHA256)
function generateBybitSignature(
    timestamp: string,
    apiKey: string,
    recvWindow: string,
    queryString: string,
    secretKey: string
): string {
    const preHash = timestamp + apiKey + recvWindow + queryString;
    const signature = crypto.createHmac('sha256', secretKey).update(preHash).digest('hex');
    return signature;
}

// Helper function to make signed Bybit API requests
async function bybitRequest(
    apiKey: string,
    apiSecret: string,
    method: string,
    endpoint: string,
    params: BybitRequestParams = {}
): Promise<any> {
    return new Promise((resolve, reject) => {
        const timestamp = Date.now().toString();
        const recvWindow = '5000';

        // Build query string for GET requests
        let queryString = '';
        if (method === 'GET' && Object.keys(params).length > 0) {
            queryString = Object.entries(params)
                .filter(([, v]) => v !== undefined)
                .sort(([a], [b]) => a.localeCompare(b)) // Sort alphabetically
                .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
                .join('&');
        }

        const signature = generateBybitSignature(timestamp, apiKey, recvWindow, queryString, apiSecret);

        const requestPath = queryString ? `${endpoint}?${queryString}` : endpoint;

        const options = {
            hostname: BYBIT_API_BASE,
            port: 443,
            path: requestPath,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'X-BAPI-API-KEY': apiKey,
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-SIGN': signature,
                'X-BAPI-RECV-WINDOW': recvWindow,
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.retCode && json.retCode !== 0) {
                        reject(new Error(`Bybit API Error ${json.retCode}: ${json.retMsg}`));
                    } else {
                        resolve(json);
                    }
                } catch (e) {
                    reject(new Error(`Parse error: ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
}

// Export Bybit Trades (execution list)
async function exportBybitTrades(config: ExchangeConfig, forceRefetch: boolean = false): Promise<UnifiedExecution[]> {
    const filename = path.join(process.cwd(), 'bybit_executions.csv');

    // Check for existing data
    if (!forceRefetch && csvExists(filename)) {
        console.log('[Bybit] Using existing executions data');
        return [];
    }

    const allExecutions: UnifiedExecution[] = [];
    const startTime = new Date(config.startDate).getTime();
    const endTime = new Date(config.endDate).getTime();

    let cursor = '';
    let hasMore = true;

    console.log('[Bybit] Fetching trade history...');

    while (hasMore) {
        const params: BybitRequestParams = {
            category: 'linear',  // Linear perpetual
            startTime: startTime,
            endTime: endTime,
            limit: 100,
        };

        if (cursor) {
            params.cursor = cursor;
        }

        const response = await bybitRequest(
            config.apiKey,
            config.apiSecret,
            'GET',
            '/v5/execution/list',
            params
        );

        const executions = response.result?.list || [];

        for (const exec of executions) {
            const displaySymbol = formatSymbol(exec.symbol, 'bybit');

            allExecutions.push({
                execID: exec.execId,
                orderID: exec.orderId,
                symbol: exec.symbol,
                displaySymbol: displaySymbol,
                side: exec.side === 'Buy' ? 'Buy' : 'Sell',
                lastQty: parseFloat(exec.execQty),
                lastPx: parseFloat(exec.execPrice),
                execType: exec.execType === 'Trade' ? 'Trade' : 'Trade',
                ordType: exec.orderType || 'Limit',
                ordStatus: 'Filled',
                execCost: parseFloat(exec.execValue) * 100000000, // Convert to satoshis equivalent
                execComm: parseFloat(exec.execFee) * 100000000,
                timestamp: new Date(parseInt(exec.execTime)).toISOString(),
                text: `positionIdx:${exec.side}`,  // Use for position side tracking
                exchange: 'bybit',
            });
        }

        // Check for more data
        cursor = response.result?.nextPageCursor || '';
        hasMore = !!cursor && executions.length > 0;

        if (hasMore) {
            await sleep(REQUEST_DELAY);
        }

        console.log(`[Bybit] Fetched ${allExecutions.length} executions...`);
    }

    // Save to CSV
    if (allExecutions.length > 0) {
        const headers = ['execID', 'orderID', 'symbol', 'displaySymbol', 'side', 'lastQty', 'lastPx', 'execType', 'ordType', 'ordStatus', 'execCost', 'execComm', 'timestamp', 'text', 'exchange'];
        const rows = allExecutions.map(e => [
            e.execID, e.orderID, e.symbol, e.displaySymbol, e.side,
            e.lastQty, e.lastPx, e.execType, e.ordType, e.ordStatus,
            e.execCost, e.execComm, e.timestamp, e.text, e.exchange
        ].join(','));
        fs.writeFileSync(filename, headers.join(',') + '\n' + rows.join('\n'));
        console.log(`[Bybit] Saved ${allExecutions.length} executions to ${filename}`);
    }

    return allExecutions;
}

// Export Bybit Wallet History
async function exportBybitWalletHistory(config: ExchangeConfig, forceRefetch: boolean = false): Promise<UnifiedWalletTransaction[]> {
    const filename = path.join(process.cwd(), 'bybit_wallet_history.csv');

    if (!forceRefetch && csvExists(filename)) {
        console.log('[Bybit] Using existing wallet history data');
        return [];
    }

    const allTransactions: UnifiedWalletTransaction[] = [];
    const startTime = new Date(config.startDate).getTime();
    const endTime = new Date(config.endDate).getTime();

    let cursor = '';
    let hasMore = true;

    console.log('[Bybit] Fetching wallet history...');

    while (hasMore) {
        const params: BybitRequestParams = {
            accountType: 'UNIFIED',
            category: 'linear',
            startTime: startTime,
            endTime: endTime,
            limit: 50,
        };

        if (cursor) {
            params.cursor = cursor;
        }

        const response = await bybitRequest(
            config.apiKey,
            config.apiSecret,
            'GET',
            '/v5/account/transaction-log',
            params
        );

        const transactions = response.result?.list || [];

        for (const tx of transactions) {
            let transactType: UnifiedWalletTransaction['transactType'] = 'RealisedPNL';
            if (tx.type === 'TRADE') transactType = 'RealisedPNL';
            else if (tx.type === 'FUNDING') transactType = 'Funding';
            else if (tx.type === 'DEPOSIT') transactType = 'Deposit';
            else if (tx.type === 'WITHDRAW') transactType = 'Withdrawal';
            else if (tx.type === 'TRANSFER_IN' || tx.type === 'TRANSFER_OUT') transactType = 'Transfer';

            allTransactions.push({
                transactID: tx.id,
                account: tx.accountId || '',
                currency: tx.currency || 'USDT',
                transactType: transactType,
                amount: parseFloat(tx.cashFlow) * 100000000,
                fee: parseFloat(tx.fee || '0') * 100000000,
                transactStatus: 'Completed',
                address: '',
                tx: '',
                text: tx.type || '',
                timestamp: new Date(parseInt(tx.transactionTime)).toISOString(),
                walletBalance: parseFloat(tx.walletBalance || '0') * 100000000,
                marginBalance: null,
                exchange: 'bybit',
            });
        }

        cursor = response.result?.nextPageCursor || '';
        hasMore = !!cursor && transactions.length > 0;

        if (hasMore) {
            await sleep(REQUEST_DELAY);
        }

        console.log(`[Bybit] Fetched ${allTransactions.length} wallet transactions...`);
    }

    // Save to CSV
    if (allTransactions.length > 0) {
        const headers = ['transactID', 'account', 'currency', 'transactType', 'amount', 'fee', 'transactStatus', 'address', 'tx', 'text', 'timestamp', 'walletBalance', 'marginBalance', 'exchange'];
        const rows = allTransactions.map(t => [
            t.transactID, t.account, t.currency, t.transactType, t.amount, t.fee,
            t.transactStatus, t.address, t.tx, t.text, t.timestamp, t.walletBalance, t.marginBalance, t.exchange
        ].join(','));
        fs.writeFileSync(filename, headers.join(',') + '\n' + rows.join('\n'));
        console.log(`[Bybit] Saved ${allTransactions.length} wallet transactions to ${filename}`);
    }

    return allTransactions;
}

// ============================================================================
// Export Bybit Closed PnL - For accurate position history
// This gives us the complete closed position records with realized PnL
// ============================================================================

export interface BybitClosedPnlRecord {
    symbol: string;
    side: 'Buy' | 'Sell';  // Position side, not trade side
    qty: number;
    orderPrice: number;
    avgEntryPrice: number;
    avgExitPrice: number;
    closedPnl: number;
    cumEntryValue: number;
    cumExitValue: number;
    orderId: string;
    createdTime: string;  // Close time
    updatedTime: string;
}

async function exportBybitClosedPnlWithProgress(
    config: ExchangeConfig,
    forceRefetch: boolean,
    log: (msg: string, type?: 'info' | 'success' | 'error' | 'warning') => void
): Promise<BybitClosedPnlRecord[]> {
    const filename = path.join(process.cwd(), 'bybit_closed_pnl.csv');

    if (!forceRefetch && csvExists(filename)) {
        log('📁 使用現有平倉記錄', 'info');
        return [];
    }

    const allRecords: BybitClosedPnlRecord[] = [];
    let startTime = new Date(config.startDate).getTime();
    const endTime = new Date(config.endDate).getTime();

    // Bybit API limit: 2 years and 7 days per request
    const TWO_YEARS_AGO = Date.now() - ((730 - 7) * 24 * 60 * 60 * 1000);
    if (startTime < TWO_YEARS_AGO) {
        startTime = TWO_YEARS_AGO;
    }

    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const timeChunks: { start: number; end: number }[] = [];
    let chunkStart = startTime;
    while (chunkStart < endTime) {
        const chunkEnd = Math.min(chunkStart + SEVEN_DAYS_MS - 1, endTime);
        timeChunks.push({ start: chunkStart, end: chunkEnd });
        chunkStart = chunkEnd + 1;
    }

    for (let chunkIdx = 0; chunkIdx < timeChunks.length; chunkIdx++) {
        const chunk = timeChunks[chunkIdx];

        let cursor = '';
        let hasMore = true;

        while (hasMore) {
            const params: BybitRequestParams = {
                category: 'linear',
                startTime: chunk.start,
                endTime: chunk.end,
                limit: 100,
            };

            if (cursor) {
                params.cursor = cursor;
            }

            const response = await bybitRequest(
                config.apiKey,
                config.apiSecret,
                'GET',
                '/v5/position/closed-pnl',
                params
            );

            const records = response.result?.list || [];

            for (const rec of records) {
                allRecords.push({
                    symbol: rec.symbol,
                    side: rec.side,  // This is the position side (Long/Short)
                    qty: parseFloat(rec.qty),
                    orderPrice: parseFloat(rec.orderPrice),
                    avgEntryPrice: parseFloat(rec.avgEntryPrice),
                    avgExitPrice: parseFloat(rec.avgExitPrice),
                    closedPnl: parseFloat(rec.closedPnl),
                    cumEntryValue: parseFloat(rec.cumEntryValue),
                    cumExitValue: parseFloat(rec.cumExitValue),
                    orderId: rec.orderId,
                    createdTime: new Date(parseInt(rec.createdTime)).toISOString(),
                    updatedTime: new Date(parseInt(rec.updatedTime)).toISOString(),
                });
            }

            cursor = response.result?.nextPageCursor || '';
            hasMore = !!cursor && records.length > 0;

            if (hasMore) {
                await sleep(REQUEST_DELAY);
            }
        }

        if ((chunkIdx + 1) % 10 === 0 || chunkIdx === timeChunks.length - 1 || allRecords.length > 0) {
            log(`📈 平倉記錄進度: ${chunkIdx + 1}/${timeChunks.length} 批次，累計 ${allRecords.length} 筆`, 'info');
        }

        if (chunkIdx < timeChunks.length - 1) {
            await sleep(REQUEST_DELAY);
        }
    }

    // Save to CSV
    if (allRecords.length > 0) {
        const headers = ['symbol', 'side', 'qty', 'orderPrice', 'avgEntryPrice', 'avgExitPrice', 'closedPnl', 'cumEntryValue', 'cumExitValue', 'orderId', 'createdTime', 'updatedTime'];
        const rows = allRecords.map(r => [
            r.symbol, r.side, r.qty, r.orderPrice, r.avgEntryPrice, r.avgExitPrice,
            r.closedPnl, r.cumEntryValue, r.cumExitValue, r.orderId, r.createdTime, r.updatedTime
        ].join(','));
        fs.writeFileSync(filename, headers.join(',') + '\n' + rows.join('\n'));
    }

    return allRecords;
}

// Get Bybit Account Info
async function getBybitAccountInfo(config: ExchangeConfig): Promise<UnifiedAccountSummary> {
    console.log('[Bybit] Fetching account info...');

    const response = await bybitRequest(
        config.apiKey,
        config.apiSecret,
        'GET',
        '/v5/account/wallet-balance',
        { accountType: 'UNIFIED' }
    );

    const account = response.result?.list?.[0] || {};
    const coin = account.coin?.find((c: any) => c.coin === 'USDT') || {};

    return {
        exportDate: new Date().toISOString(),
        exchange: 'bybit',
        user: {
            id: '',
            username: 'Bybit User',
        },
        wallet: {
            walletBalance: parseFloat(coin.walletBalance || '0'),
            marginBalance: parseFloat(coin.equity || '0'),
            availableMargin: parseFloat(coin.availableToWithdraw || '0'),
            unrealisedPnl: parseFloat(coin.unrealisedPnl || '0'),
            realisedPnl: parseFloat(coin.cumRealisedPnl || '0'),
            currency: 'USDT',
        },
        positions: [],
    };
}

// Main export function
export async function exportBybitData(config: ExchangeConfig): Promise<ImportResult> {
    try {
        console.log('[Bybit] Starting data export...');

        const executions = await exportBybitTrades(config, config.forceRefetch);
        await sleep(REQUEST_DELAY);

        const walletHistory = await exportBybitWalletHistory(config, config.forceRefetch);
        await sleep(REQUEST_DELAY);

        const accountInfo = await getBybitAccountInfo(config);

        // Save account summary
        const summaryFilename = path.join(process.cwd(), 'bybit_account_summary.json');
        fs.writeFileSync(summaryFilename, JSON.stringify(accountInfo, null, 2));

        return {
            success: true,
            message: 'Bybit data exported successfully',
            stats: {
                executions: executions.length,
                trades: executions.length,
                orders: 0,
                walletHistory: walletHistory.length,
            },
        };
    } catch (error: any) {
        console.error('[Bybit] Export error:', error);
        return {
            success: false,
            message: error.message || 'Unknown error',
            error: error.message,
        };
    }
}

// Test connection
export async function testBybitConnection(apiKey: string, apiSecret: string): Promise<{ success: boolean; message: string }> {
    try {
        await bybitRequest(apiKey, apiSecret, 'GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
        return { success: true, message: 'Bybit connection successful' };
    } catch (error: any) {
        return { success: false, message: error.message || 'Connection failed' };
    }
}

// ============================================================================
// STREAMING VERSION - With real-time progress callbacks
// ============================================================================

type LogCallback = (message: string, type?: 'info' | 'success' | 'error' | 'warning') => void;

export async function exportBybitDataWithProgress(
    config: ExchangeConfig,
    log: LogCallback
): Promise<ImportResult> {
    let totalExecutions = 0;
    let totalWalletHistory = 0;

    try {
        log('🚀 開始連接 Bybit API...', 'info');

        // Step 1: Export trades
        log('📊 正在獲取成交記錄...', 'info');
        const executions = await exportBybitTradesWithProgress(config, config.forceRefetch || false, log);
        totalExecutions = executions.length;
        log(`✅ 成交記錄: ${totalExecutions} 筆`, 'success');
        await sleep(REQUEST_DELAY);

        // Step 2: Export wallet history
        log('💰 正在獲取錢包記錄...', 'info');
        const walletHistory = await exportBybitWalletHistoryWithProgress(config, config.forceRefetch || false, log);
        totalWalletHistory = walletHistory.length;
        log(`✅ 錢包記錄: ${totalWalletHistory} 筆`, 'success');
        await sleep(REQUEST_DELAY);

        // Step 3: Export closed PnL (position history)
        log('📈 正在獲取平倉記錄...', 'info');
        const closedPnl = await exportBybitClosedPnlWithProgress(config, config.forceRefetch || false, log);
        const totalClosedPnl = closedPnl.length;
        log(`✅ 平倉記錄: ${totalClosedPnl} 筆`, 'success');
        await sleep(REQUEST_DELAY);

        // Step 4: Get account info
        log('👤 正在獲取帳戶資訊...', 'info');
        const accountInfo = await getBybitAccountInfo(config);
        const summaryFilename = path.join(process.cwd(), 'bybit_account_summary.json');
        fs.writeFileSync(summaryFilename, JSON.stringify(accountInfo, null, 2));
        log('✅ 帳戶資訊已儲存', 'success');

        log('🎉 Bybit 數據導入完成！', 'success');

        return {
            success: true,
            message: `成功導入 ${totalExecutions} 筆成交記錄、${totalWalletHistory} 筆錢包記錄、${totalClosedPnl} 筆平倉記錄`,
            stats: {
                executions: totalExecutions,
                trades: totalExecutions,
                orders: 0,
                walletHistory: totalWalletHistory,
                closedPnl: totalClosedPnl,
            },
        };
    } catch (error: any) {
        log(`❌ 錯誤: ${error.message}`, 'error');
        return {
            success: false,
            message: error.message,
            error: error.message,
        };
    }
}

// Trades with progress (batched in 7-day chunks due to Bybit API limit)
async function exportBybitTradesWithProgress(
    config: ExchangeConfig,
    forceRefetch: boolean,
    log: LogCallback
): Promise<UnifiedExecution[]> {
    const filename = path.join(process.cwd(), 'bybit_executions.csv');

    if (!forceRefetch && csvExists(filename)) {
        log('📁 使用現有成交記錄', 'info');
        return [];
    }

    const allExecutions: UnifiedExecution[] = [];
    let startTime = new Date(config.startDate).getTime();
    const endTime = new Date(config.endDate).getTime();

    // Bybit API limit: Can only query data from the past 2 years (730 days - 7 day buffer for safety)
    const TWO_YEARS_AGO = Date.now() - ((730 - 7) * 24 * 60 * 60 * 1000);
    if (startTime < TWO_YEARS_AGO) {
        log(`⚠️ Bybit 僅支援查詢近 2 年資料，自動調整起始日期至 ${new Date(TWO_YEARS_AGO).toLocaleDateString()}`, 'warning');
        startTime = TWO_YEARS_AGO;
    }

    // Bybit API limit: 7 days max per request
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

    // Create time chunks
    const timeChunks: { start: number; end: number }[] = [];
    let chunkStart = startTime;
    while (chunkStart < endTime) {
        const chunkEnd = Math.min(chunkStart + SEVEN_DAYS_MS - 1, endTime);
        timeChunks.push({ start: chunkStart, end: chunkEnd });
        chunkStart = chunkEnd + 1;
    }

    log(`📅 時間範圍分為 ${timeChunks.length} 個批次 (每批 7 天)`, 'info');

    for (let chunkIdx = 0; chunkIdx < timeChunks.length; chunkIdx++) {
        const chunk = timeChunks[chunkIdx];

        let cursor = '';
        let hasMore = true;

        while (hasMore) {
            const params: BybitRequestParams = {
                category: 'linear',
                startTime: chunk.start,
                endTime: chunk.end,
                limit: 100,
            };

            if (cursor) {
                params.cursor = cursor;
            }

            const response = await bybitRequest(
                config.apiKey,
                config.apiSecret,
                'GET',
                '/v5/execution/list',
                params
            );

            const executions = response.result?.list || [];

            for (const exec of executions) {
                const displaySymbol = formatSymbol(exec.symbol, 'bybit');

                allExecutions.push({
                    execID: exec.execId,
                    orderID: exec.orderId,
                    symbol: exec.symbol,
                    displaySymbol: displaySymbol,
                    side: exec.side === 'Buy' ? 'Buy' : 'Sell',
                    lastQty: parseFloat(exec.execQty),
                    lastPx: parseFloat(exec.execPrice),
                    execType: 'Trade',
                    ordType: exec.orderType || 'Limit',
                    ordStatus: 'Filled',
                    execCost: parseFloat(exec.execValue) * 100000000,
                    execComm: parseFloat(exec.execFee) * 100000000,
                    timestamp: new Date(parseInt(exec.execTime)).toISOString(),
                    text: `positionIdx:${exec.side}`,
                    exchange: 'bybit',
                });
            }

            cursor = response.result?.nextPageCursor || '';
            hasMore = !!cursor && executions.length > 0;

            if (hasMore) {
                await sleep(REQUEST_DELAY);
            }
        }

        // Only log every 10 batches or when data is found
        if ((chunkIdx + 1) % 10 === 0 || chunkIdx === timeChunks.length - 1 || allExecutions.length > 0) {
            log(`📊 進度: ${chunkIdx + 1}/${timeChunks.length} 批次，累計 ${allExecutions.length} 筆`, 'info');
        }

        if (chunkIdx < timeChunks.length - 1) {
            await sleep(REQUEST_DELAY);
        }
    }

    if (allExecutions.length > 0) {
        const headers = ['execID', 'orderID', 'symbol', 'displaySymbol', 'side', 'lastQty', 'lastPx', 'execType', 'ordType', 'ordStatus', 'execCost', 'execComm', 'timestamp', 'text', 'exchange'];
        const rows = allExecutions.map(e => [
            e.execID, e.orderID, e.symbol, e.displaySymbol, e.side,
            e.lastQty, e.lastPx, e.execType, e.ordType, e.ordStatus,
            e.execCost, e.execComm, e.timestamp, e.text, e.exchange
        ].join(','));
        fs.writeFileSync(filename, headers.join(',') + '\n' + rows.join('\n'));
    }

    return allExecutions;
}

// Wallet history with progress (batched in 7-day chunks due to Bybit API limit)
async function exportBybitWalletHistoryWithProgress(
    config: ExchangeConfig,
    forceRefetch: boolean,
    log: LogCallback
): Promise<UnifiedWalletTransaction[]> {
    const filename = path.join(process.cwd(), 'bybit_wallet_history.csv');

    if (!forceRefetch && csvExists(filename)) {
        log('📁 使用現有錢包記錄', 'info');
        return [];
    }

    const allTransactions: UnifiedWalletTransaction[] = [];
    let startTime = new Date(config.startDate).getTime();
    const endTime = new Date(config.endDate).getTime();

    // Bybit API limit: Can only query data from the past 2 years
    // Bybit API limit: Can only query data from the past 2 years (730 days - 7 day buffer for safety)
    const TWO_YEARS_AGO = Date.now() - ((730 - 7) * 24 * 60 * 60 * 1000);
    if (startTime < TWO_YEARS_AGO) {
        startTime = TWO_YEARS_AGO;
    }

    // Bybit API limit: 7 days max per request
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

    // Create time chunks
    const timeChunks: { start: number; end: number }[] = [];
    let chunkStart = startTime;
    while (chunkStart < endTime) {
        const chunkEnd = Math.min(chunkStart + SEVEN_DAYS_MS - 1, endTime);
        timeChunks.push({ start: chunkStart, end: chunkEnd });
        chunkStart = chunkEnd + 1;
    }

    for (let chunkIdx = 0; chunkIdx < timeChunks.length; chunkIdx++) {
        const chunk = timeChunks[chunkIdx];

        let cursor = '';
        let hasMore = true;

        while (hasMore) {
            const params: BybitRequestParams = {
                accountType: 'UNIFIED',
                category: 'linear',
                startTime: chunk.start,
                endTime: chunk.end,
                limit: 50,
            };

            if (cursor) {
                params.cursor = cursor;
            }

            const response = await bybitRequest(
                config.apiKey,
                config.apiSecret,
                'GET',
                '/v5/account/transaction-log',
                params
            );

            const transactions = response.result?.list || [];

            for (const tx of transactions) {
                let transactType: UnifiedWalletTransaction['transactType'] = 'RealisedPNL';
                if (tx.type === 'TRADE') transactType = 'RealisedPNL';
                else if (tx.type === 'FUNDING') transactType = 'Funding';
                else if (tx.type === 'DEPOSIT') transactType = 'Deposit';
                else if (tx.type === 'WITHDRAW') transactType = 'Withdrawal';
                else if (tx.type === 'TRANSFER_IN' || tx.type === 'TRANSFER_OUT') transactType = 'Transfer';

                allTransactions.push({
                    transactID: tx.id,
                    account: tx.accountId || '',
                    currency: tx.currency || 'USDT',
                    transactType: transactType,
                    amount: parseFloat(tx.cashFlow) * 100000000,
                    fee: parseFloat(tx.fee || '0') * 100000000,
                    transactStatus: 'Completed',
                    address: '',
                    tx: '',
                    text: tx.type || '',
                    timestamp: new Date(parseInt(tx.transactionTime)).toISOString(),
                    walletBalance: parseFloat(tx.walletBalance || '0') * 100000000,
                    marginBalance: null,
                    exchange: 'bybit',
                });
            }

            cursor = response.result?.nextPageCursor || '';
            hasMore = !!cursor && transactions.length > 0;

            if (hasMore) {
                await sleep(REQUEST_DELAY);
            }
        }

        // Only log every 10 batches or at the end
        if ((chunkIdx + 1) % 10 === 0 || chunkIdx === timeChunks.length - 1 || allTransactions.length > 0) {
            log(`💰 進度: ${chunkIdx + 1}/${timeChunks.length} 批次，累計 ${allTransactions.length} 筆`, 'info');
        }

        if (chunkIdx < timeChunks.length - 1) {
            await sleep(REQUEST_DELAY);
        }
    }

    if (allTransactions.length > 0) {
        const headers = ['transactID', 'account', 'currency', 'transactType', 'amount', 'fee', 'transactStatus', 'address', 'tx', 'text', 'timestamp', 'walletBalance', 'marginBalance', 'exchange'];
        const rows = allTransactions.map(t => [
            t.transactID, t.account, t.currency, t.transactType, t.amount, t.fee,
            t.transactStatus, t.address, t.tx, t.text, t.timestamp, t.walletBalance, t.marginBalance, t.exchange
        ].join(','));
        fs.writeFileSync(filename, headers.join(',') + '\n' + rows.join('\n'));
    }

    return allTransactions;
}
