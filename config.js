module.exports = {
    host: 'yourdomainhere',
    port: 25565,
    username: 'microsoftaccountmail',
    version: '1.21',
    auth: 'microsoft',
    // 大模型语义解析配置（用于 !!kd ...~~）
    semanticParser: {
        baseUrl: process.env.LLM_API_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: process.env.LLM_MODEL || 'qwen3.5-plus',
        apiKey: process.env.LLM_API_KEY || 'sk-xxx',
        timeoutMs: 20000
    },
    // 启动后自动复位坐标
    resetPosition: { x: 160, y: 50, z: 0 },
    // goto 指令寻路超时（毫秒）
    gotoPathTimeoutMs: 24000,
    // grab 指令寻路超时（毫秒），默认建议 8000~15000
    grabPathTimeoutMs: 24000,
    // 拟人行为：玩家靠近时锁定视角跟随（总开关名必须为“拟人”）
    拟人: {
        enabled: false,
        lockDistance: 4,
        unlockDistance: 6,
        lookIntervalMs: 180
    },
    // 定义不同的扫描区域
    areas: {
        left: { name: '全物品左侧', min: {x: 149, y: 43, z: -74}, max: {x: 173, y: 63, z: -8} },
        right: { name: '全物品右侧', min: {x: 148, y: 43, z: 8}, max: {x: 173, y: 59, z: 89} },
        bulk: { name: '大宗仓库', min: {x: 175, y: 43, z: -19}, max: {x: 256, y: 101, z: 19} },
        unstackable: { name: '不可堆叠区', min: {x: 130, y: 43, z: 8}, max: {x: 143, y: 58, z: 89} }
    }
};