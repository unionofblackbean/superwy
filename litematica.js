/**
 * Litematica 文件解析模块
 * 功能：解析 .litematic 文件，提取所需的材料清单（处理特殊状态方块）
 */

const fs = require('fs');
const zlib = require('zlib');
const nbt = require('prismarine-nbt');
const path = require('path');

/**
 * 特殊状态方块处理规则
 * 根据 Litematica 源码的 getStateToItemOverride 逻辑
 */
const SPECIAL_BLOCK_RULES = {
    // 无法获取的方块（返回空）
    'impossible': [
        'minecraft:piston_head',
        'minecraft:moving_piston',
        'minecraft:nether_portal',
        'minecraft:end_portal',
        'minecraft:end_gateway'
    ],
    
    // 特殊映射规则
    'mappings': {
        'minecraft:farmland': 'minecraft:dirt',
        'minecraft:brown_mushroom_block': 'minecraft:brown_mushroom_block',
        'minecraft:red_mushroom_block': 'minecraft:red_mushroom_block'
    },
    
    // 流体特殊处理（仅 level=0 时可以获取为桶）
    'fluid_buckets': {
        'minecraft:lava': 'minecraft:lava_bucket',
        'minecraft:water': 'minecraft:water_bucket'
    },
    
    // 双方块的上半部分无法获取
    'upper_half_invalid': [
        'minecraft:oak_door',
        'minecraft:spruce_door',
        'minecraft:birch_door',
        'minecraft:jungle_door',
        'minecraft:acacia_door',
        'minecraft:dark_oak_door',
        'minecraft:crimson_door',
        'minecraft:warped_door',
        'minecraft:oak_bed',
        'minecraft:spruce_bed',
        'minecraft:birch_bed',
        'minecraft:jungle_bed',
        'minecraft:acacia_bed',
        'minecraft:dark_oak_bed',
        'minecraft:red_bed',
        'minecraft:black_bed',
        'minecraft:blue_bed',
        'minecraft:brown_bed',
        'minecraft:cyan_bed',
        'minecraft:gray_bed',
        'minecraft:green_bed',
        'minecraft:light_blue_bed',
        'minecraft:light_gray_bed',
        'minecraft:lime_bed',
        'minecraft:magenta_bed',
        'minecraft:orange_bed',
        'minecraft:pink_bed',
        'minecraft:purple_bed',
        'minecraft:white_bed',
        'minecraft:yellow_bed',
        'minecraft:tall_grass',
        'minecraft:large_fern',
        'minecraft:sunflower',
        'minecraft:lilac',
        'minecraft:rose_bush',
        'minecraft:peony',
        'minecraft:tall_seagrass'
    ],
    
    // 盆栽花特殊处理（需要花盆 + 植物）
    'potted_plants': {
        'minecraft:oak_sapling': 'minecraft:potted_oak_sapling',
        'minecraft:spruce_sapling': 'minecraft:potted_spruce_sapling',
        'minecraft:birch_sapling': 'minecraft:potted_birch_sapling',
        'minecraft:jungle_sapling': 'minecraft:potted_jungle_sapling',
        'minecraft:acacia_sapling': 'minecraft:potted_acacia_sapling',
        'minecraft:dark_oak_sapling': 'minecraft:potted_dark_oak_sapling',
        'minecraft:brown_mushroom': 'minecraft:potted_brown_mushroom',
        'minecraft:red_mushroom': 'minecraft:potted_red_mushroom',
        'minecraft:dead_bush': 'minecraft:potted_dead_bush',
        'minecraft:fern': 'minecraft:potted_fern',
        'minecraft:dandelion': 'minecraft:potted_dandelion',
        'minecraft:poppy': 'minecraft:potted_poppy',
        'minecraft:blue_orchid': 'minecraft:potted_blue_orchid',
        'minecraft:allium': 'minecraft:potted_allium',
        'minecraft:azure_bluet': 'minecraft:potted_azure_bluet',
        'minecraft:red_tulip': 'minecraft:potted_red_tulip',
        'minecraft:orange_tulip': 'minecraft:potted_orange_tulip',
        'minecraft:white_tulip': 'minecraft:potted_white_tulip',
        'minecraft:pink_tulip': 'minecraft:potted_pink_tulip',
        'minecraft:oxeye_daisy': 'minecraft:potted_oxeye_daisy',
        'minecraft:cactus': 'minecraft:potted_cactus'
    }
};

/**
 * 处理单个方块状态，返回实际需要的物品
 * @param {string} blockState - 方块状态名称
 * @param {object} properties - 方块属性（如果有）
 * @returns {string|null} 返回物品名称，如果无法获取返回 null
 */
function processBlockState(blockState, properties = {}) {
    if (!blockState) return null;
    
    // 1. 检查是否为无法获取的方块
    if (SPECIAL_BLOCK_RULES.impossible.includes(blockState)) {
        console.log(`[特殊处理] ${blockState} - 无法获取`);
        return null;
    }
    
    // 2. 检查是否为双方块的上半部分
    // 通过检查属性中的 half=upper 或类似标志
    if (SPECIAL_BLOCK_RULES.upper_half_invalid.some(type => blockState.includes(type))) {
        if (properties.half === 'upper' || properties.part === 'head') {
            console.log(`[特殊处理] ${blockState} (上半部分) - 无法获取`);
            return null;
        }
    }
    
    // 3. 检查流体特殊处理（仅 level=0 时）
    if (SPECIAL_BLOCK_RULES.fluid_buckets[blockState]) {
        // properties.level 为 0 时才能获取为桶
        const level = properties.level || 0;
        if (level === 0) {
            console.log(`[特殊处理] ${blockState} (level=0) -> ${SPECIAL_BLOCK_RULES.fluid_buckets[blockState]}`);
            return SPECIAL_BLOCK_RULES.fluid_buckets[blockState];
        } else {
            // 其他 level 的流体无法获取
            console.log(`[特殊处理] ${blockState} (level=${level}) - 无法获取`);
            return null;
        }
    }
    
    // 4. 检查直接映射规则
    if (SPECIAL_BLOCK_RULES.mappings[blockState]) {
        const mapped = SPECIAL_BLOCK_RULES.mappings[blockState];
        console.log(`[特殊处理] ${blockState} -> ${mapped}`);
        return mapped;
    }
    
    // 5. 返回原始方块状态
    return blockState;
}

/**
 * 计算方块所需的物品数量（考虑特殊堆叠规则）
 * 根据 Litematica 的 MaterialCache.overrideStackSize 逻辑
 * @param {string} blockName - 方块名称
 * @param {object} properties - 方块属性
 * @returns {number} 该方块所需的物品数量
 */
function getStackSizeForBlock(blockName, properties = {}) {
    // 双倍厚板 - 需要 2 个厚板
    if (blockName === 'minecraft:double_slab' || blockName.includes('double_slab')) {
        return 2;
    }
    
    // 雪 - 根据层数计算
    if (blockName === 'minecraft:snow' || blockName.includes('snow')) {
        const layers = properties.layers || 1;
        return Math.min(layers, 8); // 最多 8 层
    }
    
    // 海龟蛋 - 根据蛋的数量
    if (blockName === 'minecraft:turtle_egg') {
        const eggs = properties.eggs || 1;
        return Math.min(eggs, 4); // 最多 4 个蛋
    }
    
    // 海星 - 根据星的数量
    if (blockName === 'minecraft:sea_pickle') {
        const pickles = properties.pickles || 1;
        return Math.min(pickles, 4); // 最多 4 个星
    }
    
    // 蜡烛 - 根据蜡烛数量
    if (blockName.includes('candle')) {
        const candles = properties.candles || 1;
        return Math.min(candles, 4); // 最多 4 根蜡烛
    }
    
    // 多面生长方块 (多面紫黑藤等) - 根据方向数
    // 这些方块的属性中会有多个方向 (north, south, east, west, up, down)
    if (blockName.includes('sculk_vein') || blockName.includes('cave_vines') || blockName.includes('protocol') || blockName.includes('weeping_vines') || blockName.includes('twisting_vines')) {
        let directionCount = 0;
        const directions = ['north', 'south', 'east', 'west', 'up', 'down'];
        for (const dir of directions) {
            if (properties[dir] === true) {
                directionCount++;
            }
        }
        return Math.max(1, directionCount); // 至少返回 1
    }
    
    // 默认返回 1
    return 1;
}

/**
 * 解析 litematic 文件
 * @param {string} filePath - litematic 文件路径
 * @returns {Promise<{materials: Map, metadata: Object, error?: string}>}
 */
async function parseLitematica(filePath) {
    try {
        // 读取文件
        const fileBuffer = fs.readFileSync(filePath);
        
        // 解析 NBT（Litematica 使用 Gzip 压缩）
        const { parsed } = await nbt.parse(fileBuffer);
        const data = nbt.simplify(parsed);
        
        // 验证数据格式
        if (!data) {
            throw new Error('无法解析 NBT 数据');
        }
        
        // 获取元数据
        const metadata = data.Metadata || {};
        const projectName = metadata.Name || '未命名项目';
        console.log(`\x1b[36m%s\x1b[0m`, `[Litematica] 项目名称: ${projectName}`);
        
        // 材料计数 Map
        const materials = new Map();
        
        // 获取所有区域
        const regions = data.Regions || {};
        if (Object.keys(regions).length === 0) {
            throw new Error('投影文件中未找到任何区域');
        }
        
        // 遍历每个区域
        for (const regionName in regions) {
            const region = regions[regionName];
            
            // 获取区域尺寸信息
            const size = region.Size || {};
            console.log(`\x1b[33m%s\x1b[0m`, `[区域] 名称: ${regionName}, 尺寸: ${size.x || '?'}x${size.y || '?'}x${size.z || '?'}`);
            
            // 获取方块调色盘（所有使用到的方块类型）
            const palette = region.BlockStatePalette || [];
            console.log(`\x1b[35m%s\x1b[0m`, `[调色盘] 包含 ${palette.length} 种方块状态`);
            
            // 统计每种方块类型
            for (const blockState of palette) {
                // 从方块状态中提取方块名称和属性
                let blockName = blockState;
                let properties = {};
                
                // 如果是对象格式，提取 Name 和 Properties 字段
                if (typeof blockState === 'object' && blockState.Name) {
                    blockName = blockState.Name;
                    properties = blockState.Properties || {};
                }
                
                // 规范化方块名称
                if (typeof blockName === 'string') {
                    // 处理特殊状态方块
                    const processedBlock = processBlockState(blockName, properties);
                    
                    if (processedBlock) {
                        // 计算该方块所需的物品数量（考虑特殊堆叠规则）
                        const stackSize = getStackSizeForBlock(processedBlock, properties);
                        const count = materials.get(processedBlock) || 0;
                        materials.set(processedBlock, count + stackSize);
                        
                        // 如果堆数量大于 1，输出日志
                        if (stackSize > 1) {
                            console.log(`[堆数处理] ${processedBlock} 需要 ${stackSize} 个物品`);
                        }
                    }
                    // 如果返回 null，说明该方块无法获取，跳过计数
                }
            }
        }
        
        if (materials.size === 0) {
            throw new Error('未找到任何可获取的方块数据');
        }
        
        console.log(`\x1b[36m%s\x1b[0m`, `[Litematica] 已解析可获取材料 ${materials.size} 种`);
        
        return { materials, metadata };
    } catch (err) {
        console.error('[Litematica解析错误]', err.message);
        return { 
            error: `解析失败: ${err.message}`,
            materials: new Map(),
            metadata: {}
        };
    }
}

/**
 * 对比材料与库存
 * @param {Map} requiredMaterials - 所需材料 Map
 * @param {Array} inventory - 当前库存 [{id, name_zh, count}, ...]
 * @returns {Object} - {sufficient: [], insufficient: [], missing: []}
 */
function compareMaterialsWithInventory(requiredMaterials, inventory) {
    const inventoryMap = new Map();
    
    // 构建库存映射（去掉 minecraft: 前缀）
    for (const item of inventory) {
        const shortId = item.id.replace('minecraft:', '');
        inventoryMap.set(shortId, {
            count: item.count,
            name_zh: item.name_zh
        });
    }
    
    const result = {
        sufficient: [],      // 充足的材料
        insufficient: [],    // 不足的材料
        missing: []         // 缺少的材料
    };
    
    // 对比每种材料
    for (const [material, required] of requiredMaterials.entries()) {
        // 清理材料名称（去掉 minecraft: 前缀）
        const cleanMaterial = material.replace('minecraft:', '');
        const inventoryItem = inventoryMap.get(cleanMaterial) || { count: 0, name_zh: null };
        const available = inventoryItem.count || 0;
        
        const item = {
            material: cleanMaterial,
            name_zh: inventoryItem.name_zh,
            required,
            available
        };
        
        if (available >= required) {
            result.sufficient.push(item);
        } else if (available > 0) {
            item.lacking = required - available;
            result.insufficient.push(item);
        } else {
            result.missing.push(item);
        }
    }
    
    return result;
}

module.exports = {
    parseLitematica,
    compareMaterialsWithInventory
};
