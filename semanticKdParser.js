const config = require('./config');

const SYSTEM_PROMPT = [
    '你是 Minecraft 仓库空投指令解析器。',
    '你的任务是把玩家中文自然语言请求解析为结构化参数，供 !!kd 指令执行。',
    '只输出 JSON，不要输出任何额外文本。',
    '',
    '解析目标：',
    '1) itemName: 物品英文ID短名（例如 white_concrete, golden_apple）',
    '2) count: 正整数数量，默认 64',
    '3) confidence: 0~1 浮点数，表示你对解析结果的信心',
    '4) normalizedCommand: 规范化命令字符串，必须是英文ID，格式为 "!!kd <english_item_id> <count>"',
    '5) explanation: 一句话解释你如何从原文得出结果',
    '',
    '规则：',
    '- 用户可能说“快递/空投/送/给我来”等同义表达。',
    '- 如果文本里没有明确数量，count=64。',
    '- 如果数量不合法（负数、0、非数字）则按默认 64。',
    '- itemName 不能为空。',
    '- 返回 JSON Schema:',
    '{',
    '  "itemName": "string",',
    '  "count": 64,',
    '  "confidence": 0.95,',
    '  "normalizedCommand": "!!kd white_concrete 64",',
    '  "explanation": "..."',
    '}'
].join('\n');

class SemanticKdParser {
    constructor(options = {}) {
        const conf = config.semanticParser || {};
        this.apiKey = options.apiKey || process.env.LLM_API_KEY || conf.apiKey || '';
        this.baseUrl = options.baseUrl || process.env.LLM_API_BASE_URL || conf.baseUrl || 'https://api.openai.com/v1';
        this.model = options.model || process.env.LLM_MODEL || conf.model || 'gpt-4o-mini';
        this.timeoutMs = Number(options.timeoutMs || process.env.LLM_TIMEOUT_MS || conf.timeoutMs || 10000);
    }

    ensureReady() {
        if (!this.apiKey) {
            throw new Error('未配置 LLM API Key（请设置 LLM_API_KEY 或 config.semanticParser.apiKey）');
        }
    }

    extractJsonText(rawText) {
        const text = String(rawText || '').trim();
        if (!text) {
            throw new Error('LLM 返回为空');
        }

        const first = text.indexOf('{');
        const last = text.lastIndexOf('}');
        if (first < 0 || last < 0 || last < first) {
            throw new Error(`LLM 返回非 JSON: ${text}`);
        }

        return text.slice(first, last + 1);
    }

    normalizeResult(payload) {
        const itemName = String(payload.itemName || '').trim();
        if (!itemName) {
            throw new Error('语义解析失败：itemName 为空');
        }

        let count = Number(payload.count);
        if (!Number.isFinite(count) || count <= 0) {
            count = 64;
        }

        const confidenceNum = Number(payload.confidence);
        const confidence = Number.isFinite(confidenceNum)
            ? Math.max(0, Math.min(1, confidenceNum))
            : 0;

        const normalizedCommand = String(payload.normalizedCommand || `!!kd ${itemName} ${Math.floor(count)}`).trim();
        const explanation = String(payload.explanation || '').trim();

        return {
            itemName,
            count: Math.floor(count),
            confidence,
            normalizedCommand,
            explanation
        };
    }

    async parse(naturalText) {
        this.ensureReady();

        if (typeof fetch !== 'function') {
            throw new Error('当前 Node 环境不支持 fetch，请升级 Node 版本或为项目注入 fetch 实现');
        }

        const input = String(naturalText || '').trim();
        if (!input) {
            throw new Error('语义解析输入为空');
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: this.model,
                    temperature: 0,
                    messages: [
                        { role: 'system', content: SYSTEM_PROMPT },
                        { role: 'user', content: `请解析这句话：${input}` }
                    ]
                }),
                signal: controller.signal
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`LLM 请求失败 ${response.status}: ${errText}`);
            }

            const data = await response.json();
            const content = data?.choices?.[0]?.message?.content || '';
            const jsonText = this.extractJsonText(content);
            const payload = JSON.parse(jsonText);
            return this.normalizeResult(payload);
        } catch (err) {
            if (err.name === 'AbortError') {
                throw new Error(`LLM 请求超时（>${this.timeoutMs}ms）`);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }
}

module.exports = { SemanticKdParser, SYSTEM_PROMPT };
