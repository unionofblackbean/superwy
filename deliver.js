const mcData = require('minecraft-data')('1.21');
const taskQueue = require('./taskQueue');

class DeliverService {
    constructor(bot) {
        this.bot = bot;
        this.isRunning = false;
        this.fakePlayerName = 'sf';
    }

    normalizeKeyword(input) {
        const raw = String(input || '').trim();
        if (!raw) return '';
        return raw.replace(/^minecraft:/i, '').toLowerCase();
    }

    collectMatchingStacks(keyword) {
        const normalized = this.normalizeKeyword(keyword);
        if (!normalized) return [];

        return this.bot.inventory.items().filter((item) => {
            const name = String(item.name || '').toLowerCase();
            const displayName = String(item.displayName || '').toLowerCase();
            const canonical = String(mcData.items[item.type]?.name || '').toLowerCase();
            return (
                name === normalized ||
                canonical === normalized ||
                displayName === normalized ||
                name.includes(normalized) ||
                displayName.includes(normalized)
            );
        });
    }

    getMatchingCount(keyword) {
        return this.collectMatchingStacks(keyword).reduce((sum, item) => sum + item.count, 0);
    }

    async lookAtDropTarget(targetPos) {
        if (!targetPos) {
            return;
        }
        await this.bot.lookAt(targetPos, true);
    }

    async stepBack(distance = 3, targetPos = null) {
        // 采用按键后退，避免 yaw->坐标换算符号导致前后方向颠倒
        const durationMs = Math.max(350, Math.round((distance / 4.3) * 1000));
        this.bot.setControlState('back', true);
        await new Promise((r) => setTimeout(r, durationMs));
        this.bot.setControlState('back', false);

        const currentPos = this.bot.entity?.position;
        if (currentPos && targetPos) {
            const horizontalDistance = Math.hypot(currentPos.x - targetPos.x, currentPos.z - targetPos.z);
            console.log(`[投递] 后退完成：与目标水平距离 ${horizontalDistance.toFixed(2)} 格`);
        }
    }

    async tossStacks(stacks, targetPos, throwIfAborted = () => {}) {
        let tossedCount = 0;
        for (const stack of stacks) {
            throwIfAborted();
            // 每次从当前背包里重新取同类物品，避免 toss 后引用失效
            const liveStack = this.bot.inventory.items().find((it) =>
                it.type === stack.type && it.count > 0
            );
            if (!liveStack) continue;

            console.log(`[投递] 准备投掷堆栈: ${liveStack.name} x${liveStack.count}`);
            await this.lookAtDropTarget(targetPos);

            await this.bot.tossStack(liveStack);
            tossedCount += liveStack.count;
            console.log(`[投递] 已投掷: ${liveStack.name} x${liveStack.count}`);
            await new Promise((r) => setTimeout(r, 50));
        }
        return tossedCount;
    }

    async tossUntilEmpty(keyword, targetPos, throwIfAborted = () => {}) {
        let totalTossed = 0;
        let rounds = 0;

        while (rounds < 50) {
            throwIfAborted();
            const stacks = this.collectMatchingStacks(keyword);
            if (stacks.length === 0) {
                break;
            }

            rounds += 1;
            const beforeCount = this.getMatchingCount(keyword);
            console.log(`[投递] 第 ${rounds} 轮开始：当前剩余 ${beforeCount}`);
            const tossedRound = await this.tossStacks(stacks, targetPos, throwIfAborted);
            totalTossed += tossedRound;
            await new Promise((r) => setTimeout(r, 120));

            const afterCount = this.getMatchingCount(keyword);
            console.log(`[投递] 第 ${rounds} 轮：扔出=${tossedRound} 剩余=${afterCount}`);

            if (afterCount <= 0 || afterCount >= beforeCount) {
                break;
            }
        }

        return totalTossed;
    }

    async deliver(itemKeyword) {
        const keyword = this.normalizeKeyword(itemKeyword);
        if (!keyword) {
            throw new Error('用法: !!d <item>');
        }

        if (this.isRunning) {
            throw new Error('当前已有投递任务在执行，请稍后再试');
        }

        if (!this.bot) {
            throw new Error('Bot 未就绪');
        }

        return taskQueue.enqueueTask({
            type: 'movement',
            title: `投递 ${keyword}`,
            meta: {
                source: 'deliver.deliver',
                target: keyword
            },
            executor: async ({ setCancel, throwIfAborted }) => {
                this.isRunning = true;
                let spawned = false;
                try {
                    const stacks = this.collectMatchingStacks(keyword);
                    if (stacks.length === 0) {
                        throw new Error(`背包中未找到匹配物品: ${keyword}`);
                    }

                    const spawnPos = this.bot.entity?.position?.clone();
                    if (!spawnPos) {
                        throw new Error('无法获取 Bot 当前位置');
                    }

                    const dropTarget = spawnPos.floored().offset(0.5, 0, 0.5);

                    console.log(`[投递] 开始投递 ${keyword}，匹配堆栈 ${stacks.length}`);
                    console.log(`[投递] 环节1/5：记录投掷目标坐标 (${dropTarget.x.toFixed(1)}, ${dropTarget.y.toFixed(1)}, ${dropTarget.z.toFixed(1)})`);

                    console.log(`[投递] 环节2/5：召唤假人 ${this.fakePlayerName}`);
                    this.bot.chat(`/player ${this.fakePlayerName} spawn`);
                    spawned = true;

                    console.log('[投递] 环节3/5：后退 3 格');
                    const restoreCancel = setCancel(() => {
                        this.bot.setControlState('back', false);
                        this.bot.clearControlStates();
                    });
                    try {
                        await this.stepBack(3, dropTarget);
                    } finally {
                        restoreCancel();
                    }

                    throwIfAborted();
                    await new Promise((r) => setTimeout(r, 150));
                    console.log('[投递] 环节4/5：锁定投掷目标并循环清空背包目标物品');
                    await this.lookAtDropTarget(dropTarget);

                    const tossed = await this.tossUntilEmpty(keyword, dropTarget, throwIfAborted);

                    console.log(`[投递] 投递完成: ${keyword}，总计 ${tossed}`);

                    return { item: keyword, tossed };
                } finally {
                    if (spawned) {
                        console.log('[投递] 环节5/5：等待 3 秒后清理假人');
                        await new Promise((r) => setTimeout(r, 3000));
                        this.bot.chat(`/player ${this.fakePlayerName} kill`);
                        console.log(`[投递] 已执行 /player ${this.fakePlayerName} kill`);
                    }
                    this.isRunning = false;
                }
            }
        });
    }
}

module.exports = DeliverService;
