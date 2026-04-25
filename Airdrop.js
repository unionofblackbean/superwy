const config = require('./config');
const { goto } = require('./pathfinder');
const GrabService = require('./grab');
const DeliverService = require('./deliver');
const taskQueue = require('./taskQueue');

const KD_MAX_COUNT = 640;

class AirdropService {
    constructor(bot) {
        this.bot = bot;
        this.grabService = new GrabService(bot);
        this.deliverService = new DeliverService(bot);
        this.isRunning = false;
    }

    parseRequest(args = []) {
        const tokens = Array.isArray(args) ? args.filter(Boolean) : [];
        if (tokens.length === 0) {
            throw new Error('用法: !!kd <物品名> [数量]');
        }

        const last = tokens[tokens.length - 1];
        const maybeCount = Number(last);
        const hasCount = !Number.isNaN(maybeCount) && maybeCount > 0;

        const count = hasCount ? Math.max(1, Math.floor(maybeCount)) : 64;
        const itemTokens = hasCount ? tokens.slice(0, -1) : tokens;
        const itemName = itemTokens.join(' ').trim();

        if (!itemName) {
            throw new Error('物品名不能为空');
        }

        if (count > KD_MAX_COUNT) {
            throw new Error(`!!kd 单次最多只能取 ${KD_MAX_COUNT} 个物品`);
        }

        return { itemName, count };
    }

    async goToResetPosition() {
        const pos = config.resetPosition;
        if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
            throw new Error('config.resetPosition 未配置或格式错误');
        }

        console.log(`[空投] 返回原点: (${pos.x}, ${pos.y}, ${pos.z})`);
        await goto(this.bot, pos.x, pos.y, pos.z);
    }

    async run(args = []) {
        if (this.isRunning) {
            throw new Error('当前已有空投任务在执行，请稍后再试');
        }

        const { itemName, count } = this.parseRequest(args);

        return taskQueue.enqueueTask({
            type: 'movement',
            title: `空投 ${itemName} x${count}`,
            meta: {
                source: 'airdrop.run',
                target: `${itemName} x${count}`
            },
            executor: async ({ throwIfAborted }) => {
                this.isRunning = true;
                try {
                    console.log(`[空投] 任务开始: 物品=${itemName}, 数量=${count}`);

                    console.log('[空投] 阶段1/3: 调用 grab 取货');
                    await this.grabService.grab(itemName, count);

                    throwIfAborted();
                    console.log('[空投] 阶段2/3: 返回原点');
                    await this.goToResetPosition();

                    throwIfAborted();
                    console.log('[空投] 阶段3/3: 调用 deliver 执行空投');
                    const result = await this.deliverService.deliver(itemName);

                    console.log(`[空投] 任务完成: ${result.item} x${result.tossed}`);
                    return {
                        item: result.item,
                        requested: count,
                        delivered: result.tossed
                    };
                } finally {
                    this.isRunning = false;
                }
            }
        });
    }
}

module.exports = AirdropService;
