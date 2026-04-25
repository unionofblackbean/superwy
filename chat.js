/**
 * 机器人聊天监听模块
 * 功能：统一路由聊天命令（前缀: ! 或 !!）
 */

const { goto } = require('./pathfinder');
const GrabService = require('./grab');
const DeliverService = require('./deliver');
const AirdropService = require('./Airdrop');
const { SemanticKdParser } = require('./semanticKdParser');

function parseCommand(message) {
    const text = typeof message === 'string' ? message.trim() : '';
    if (!text.startsWith('!')) return null;

    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return null;

    const command = tokens[0].replace(/^!+/, '').toLowerCase();
    const args = tokens.slice(1);

    return { text, command, args };
}

function isSemanticAirdropText(message) {
    const text = typeof message === 'string' ? message.trim() : '';
    if (!text) return false;
    if (text.startsWith('!')) return false;
    // 支持 ~~ / ～～，并允许尾部带一个常见句末标点。
    return /(~~|～～)\s*[。.!！?？]?$/.test(text);
}

function setupChatListener(bot, handlers = {}) {
    if (!bot) {
        console.error('[聊天模块] 未检测到有效的 Bot 实例');
        return;
    }

    const grabService = new GrabService(bot);
    const deliverService = new DeliverService(bot);
    const airdropService = new AirdropService(bot);
    const semanticKdParser = new SemanticKdParser();
    const replyConsole = (msg) => console.log(`[聊天回复] ${msg}`);
    const replyGame = (msg) => {
        if (!bot) return;
        try {
            bot.chat(String(msg));
        } catch (err) {
            console.error('[聊天发送失败]', err.message);
        }
    };

    const extractKdNaturalText = (fullText) => {
        const text = String(fullText || '').trim();
        return text.replace(/^!+\s*kd\s*/i, '').trim();
    };

    const runKdFlow = ({ args, text }) => {
        const rawNatural = extractKdNaturalText(text);
        const useSemantic = rawNatural.endsWith('~~');

        if (useSemantic) {
            const plainText = rawNatural.slice(0, -2).trim();
            if (!plainText) {
                replyConsole('语义输入为空，示例: !!kd 快递20个白色混凝土~~');
                replyGame('语义输入为空，示例: !!kd 快递20个白色混凝土~~');
                return true;
            }

            replyConsole('检测到 ~~，启用大模型语义解析');
            replyGame(`收到！正在使用 ${semanticKdParser.model} 解析语义。`);
            semanticKdParser.parse(plainText).then((parsed) => {
                const resolved = grabService.resolveItem(parsed.itemName);
                const commandMatch = String(parsed.normalizedCommand || '').match(/^!!kd\s+([^\s]+)\s+(\d+)/i);
                const commandItem = commandMatch ? commandMatch[1].replace(/^minecraft:/i, '') : '';
                const resolvedItem = resolved ? String(resolved.id).replace(/^minecraft:/i, '') : '';
                const fallbackItem = String(parsed.itemName || '').replace(/^minecraft:/i, '');
                const commandItemAscii = commandItem && /^[a-z0-9_]+$/i.test(commandItem) ? commandItem : '';
                const finalItem = resolvedItem || commandItemAscii || fallbackItem;
                const normalizedCommand = `!!kd ${finalItem} ${parsed.count}`;

                replyConsole(`语义解析结果: 物品=${parsed.itemName}, 数量=${parsed.count}, 置信度=${parsed.confidence.toFixed(2)}`);
                replyGame(`语义结果: 物品=${parsed.itemName} 数量=${parsed.count} 置信度=${parsed.confidence.toFixed(2)}`);
                if (parsed.explanation) {
                    replyConsole(`语义解释: ${parsed.explanation}`);
                    replyGame(`语义解释: ${parsed.explanation}`);
                }
                if (resolvedItem) {
                    replyConsole(`语义映射: ${parsed.itemName} -> ${resolvedItem}`);
                    replyGame(`语义映射: ${parsed.itemName} -> ${resolvedItem}`);
                }
                replyConsole(`规范命令: ${normalizedCommand}`);
                replyGame(`规范命令: ${normalizedCommand}`);
                airdropService.run([finalItem, String(parsed.count)]).then((result) => {
                    replyConsole(`空投完成: ${result.item} 请求=${result.requested} 实际=${result.delivered}`);
                    replyGame(`空投完成: ${result.item} 请求=${result.requested} 实际=${result.delivered}`);
                }).catch((err) => {
                    console.error('[kd语义空投错误]', err.message);
                    replyConsole(`空投失败: ${err.message}`);
                    replyGame(`空投失败: ${err.message}`);
                });
            }).catch((err) => {
                console.error('[kd语义解析错误]', err.message);
                replyConsole(`语义解析失败: ${err.message}`);
                replyConsole('你可以改用显式命令，例如: !!kd 白色混凝土 20');
                replyGame(`语义解析失败: ${err.message}`);
                replyGame('可改用显式命令: !!kd 白色混凝土 20');
            });

            return true;
        }

        if (!args || args.length === 0) {
            replyConsole('用法: !!kd <物品名> [数量]，语义模式示例: !!kd 快递20个白色混凝土~~');
            return true;
        }

        airdropService.run(args).then((result) => {
            replyConsole(`空投完成: ${result.item} 请求=${result.requested} 实际=${result.delivered}`);
        }).catch((err) => {
            console.error('[kd指令错误]', err.message);
            replyConsole(`空投失败: ${err.message}`);
        });

        return true;
    };

    console.log('\x1b[34m%s\x1b[0m', '[聊天模块] 监听已启动 (关键词: !)');

    const routes = {
        goto: ({ username, args }) => {
            if (args.length === 1 && args[0].toLowerCase() === 'me') {
                const player = bot.players[username];
                if (player && player.entity) {
                    const pos = player.entity.position;
                    goto(bot, pos.x, pos.y, pos.z).catch((err) => {
                        console.error('[goto指令错误]', err.message);
                        replyConsole(`goto 失败: ${err.message}`);
                    });
                } else {
                    replyConsole('无法获取您的位置');
                }
                return true;
            }

            if (args.length === 3) {
                const x = Number(args[0]);
                const y = Number(args[1]);
                const z = Number(args[2]);
                if (!Number.isNaN(x) && !Number.isNaN(y) && !Number.isNaN(z)) {
                    goto(bot, x, y, z).catch((err) => {
                        console.error('[goto指令错误]', err.message);
                        replyConsole(`goto 失败: ${err.message}`);
                    });
                } else {
                    replyConsole('坐标格式错误，请使用 !goto x y z 或 !goto me');
                }
                return true;
            }

            replyConsole('用法: !goto me 或 !goto x y z');
            return true;
        },

        grab: ({ args }) => {
            if (args.length < 1) {
                replyConsole('用法: !!grab <item> [number]');
                return true;
            }

            const item = args[0];
            const number = args[1] ? Number(args[1]) : 16;
            if (args[1] && (Number.isNaN(number) || number <= 0)) {
                replyConsole('数量格式错误，示例: !!grab redstone 10');
                return true;
            }

            grabService.grab(item, number).catch((err) => {
                console.error('[grab指令错误]', err.message);
                replyConsole(`grab 执行失败: ${err.message}`);
            });
            return true;
        },

        gg: ({ username }) => {
            if (typeof handlers.onGG === 'function') {
                handlers.onGG(username);
            } else {
                replyConsole('保活模块未配置，无法执行 !!gg');
            }
            return true;
        },

        d: ({ args }) => {
            if (args.length < 1) {
                replyConsole('用法: !!d <item>');
                return true;
            }

            const item = args[0];
            deliverService.deliver(item).then((result) => {
                replyConsole(`投递完成: ${result.item} x${result.tossed}`);
            }).catch((err) => {
                console.error('[d指令错误]', err.message);
                replyConsole(`投递失败: ${err.message}`);
            });

            return true;
        },

        kd: runKdFlow
    };

    bot.on('chat', (username, message) => {
        if (username === bot.username) return;

        // 支持自然语言语义触发：无需 !!kd，只要文本以 ~~ 结尾且包含空投语义关键词
        if (isSemanticAirdropText(message)) {
            console.log(`[聊天] 收到来自 ${username} 的语义空投请求: ${message}`);
            replyConsole(`语义触发: ${message}`);
            runKdFlow({ args: [], text: `!!kd ${message}` });
            return;
        }

        const parsed = parseCommand(message);
        if (!parsed) return;

        console.log(`[聊天] 收到来自 ${username} 的信号: ${parsed.text}`);
        replyConsole(`收到: ${parsed.text}`);

        const handler = routes[parsed.command];
        if (!handler) {
            return;
        }

        try {
            handler({ username, args: parsed.args, text: parsed.text });
        } catch (err) {
            console.error(`[聊天路由错误] ${parsed.command}:`, err.message);
            replyConsole(`命令执行失败: ${parsed.command}`);
        }
    });

    // 监听系统消息（有些服务器的私聊或提示不触发 'chat' 事件）
    bot.on('messagestr', (message) => {
        if (message.includes('!') && !message.includes(bot.username)) {
            // 这种方式可以捕获包含 "!" 的非标准聊天格式
            // 但注意：某些服务器环境可能需要额外过滤
        }
    });
}

// 发送扫描开始消息
function sendScanStartMessage(bot) {
    if (bot) {
        bot.chat('开始扫描');
    }
}

// 发送扫描结束消息
function sendScanEndMessage(bot) {
    if (bot) {
        bot.chat('扫描完成');
    }
}

module.exports = { setupChatListener, sendScanStartMessage, sendScanEndMessage };