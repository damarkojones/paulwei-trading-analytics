// ============ AI Provider Types ============

export type AIProvider = 'openai' | 'claude' | 'gemini';

export interface AISettings {
    openaiApiKey: string;
    claudeApiKey: string;
    geminiApiKey: string;
    selectedProvider: AIProvider;
    systemPrompt: string;
}

export const AI_PROVIDER_NAMES: Record<AIProvider, string> = {
    openai: 'OpenAI GPT-4',
    claude: 'Anthropic Claude',
    gemini: 'Google Gemini',
};

// ============ Default System Prompt ============

export const DEFAULT_SYSTEM_PROMPT = `你是一位專業的加密貨幣交易分析師，專門分析交易歷史並提供改進建議。

## 你的分析能力：
1. **倉位分析** - 識別獲利和虧損模式
2. **風險管理** - 評估止損設置和倉位大小
3. **時機分析** - 分析進出場時機
4. **心理因素** - 識別情緒化交易行為

## 分析格式：
請按照以下格式提供分析：

### 📊 整體表現摘要
- 總結關鍵統計數據（勝率、盈虧比、最大回撤等）

### ✅ 做得好的地方
- 列出成功的交易模式和良好的執行紀律

### ⚠️ 需要改進的地方
- 分析虧損原因和常見錯誤

### 💡 具體建議
- 提供可執行的改進方案（至少3點）

### 🎯 下一步行動
- 立即可實施的調整（1-2個重點）

請用繁體中文回覆，保持專業但易懂的語氣。分析要具體，避免泛泛而談。`;

// ============ AI Analysis Types ============

export interface TradingDataForAI {
    exchange: string;
    stats: {
        totalTrades: number;
        winningTrades: number;
        losingTrades: number;
        winRate: number;
        profitFactor: number;
        avgWin: number;
        avgLoss: number;
        totalRealizedPnl: number;
        totalFunding: number;
        totalFees: number;
        netPnl: number;
        tradingDays: number;
    };
    recentPositions: {
        symbol: string;
        side: 'long' | 'short';
        pnl: number;
        duration: string;
        maxSize: number;
    }[];
    monthlyPnl: {
        month: string;
        pnl: number;
    }[];
}

export interface AIAnalysisRequest {
    provider: AIProvider;
    apiKey: string;
    systemPrompt: string;
    tradingData: TradingDataForAI;
}

export interface AIAnalysisResponse {
    success: boolean;
    analysis?: string;
    error?: string;
}

// ============ LocalStorage Keys ============

export const AI_SETTINGS_KEY = 'tradevoyage_ai_settings';

// ============ Helper Functions ============

export function getDefaultAISettings(): AISettings {
    return {
        openaiApiKey: '',
        claudeApiKey: '',
        geminiApiKey: '',
        selectedProvider: 'openai',
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
    };
}

export function loadAISettings(): AISettings {
    if (typeof window === 'undefined') return getDefaultAISettings();

    try {
        const saved = localStorage.getItem(AI_SETTINGS_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            return { ...getDefaultAISettings(), ...parsed };
        }
    } catch (e) {
        console.error('Failed to load AI settings:', e);
    }
    return getDefaultAISettings();
}

export function saveAISettings(settings: AISettings): void {
    if (typeof window === 'undefined') return;

    try {
        localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
        console.error('Failed to save AI settings:', e);
    }
}

export function getApiKeyForProvider(settings: AISettings, provider: AIProvider): string {
    switch (provider) {
        case 'openai': return settings.openaiApiKey;
        case 'claude': return settings.claudeApiKey;
        case 'gemini': return settings.geminiApiKey;
    }
}

export function hasConfiguredProvider(settings: AISettings): boolean {
    return !!(settings.openaiApiKey || settings.claudeApiKey || settings.geminiApiKey);
}
