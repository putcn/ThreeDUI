import { inject, provide, ref, type Ref } from 'vue'
import type { DemoLocale } from '../demo-locale'

const spatialLocale = Symbol('spatial-locale')

export function provideSpatialLocale(locale: Ref<DemoLocale>): void { provide(spatialLocale, locale) }

export function useSpatialLocale(): { locale: Ref<DemoLocale>; t: (text: string) => string } {
  const locale = inject<Ref<DemoLocale>>(spatialLocale, ref('zh'))
  return { locale, t: (text: string) => locale.value === 'zh' ? text : translateSpatialText(text) }
}

const EN: Record<string, string> = {
  '总览': 'Overview', '订单': 'Orders', '运营看板': 'Dashboard', '物流网络': 'Logistics network', '仓储孪生': 'Warehouse twin', '库存': 'Inventory', '设置': 'Settings',
  '云仓 WMS': 'Cloud Warehouse WMS', '徐州一号仓': 'Xuzhou Warehouse 1', '徐州二号仓': 'Xuzhou Warehouse 2', '徐州三号仓': 'Xuzhou Warehouse 3',
  '示例账号已填写，点击登录进入工作区。': 'Demo credentials are ready. Sign in to enter the workspace.', '记住我': 'Remember me', '登录': 'Sign in',
  '请输入有效的邮箱地址': 'Enter a valid email address', '密码至少 6 位': 'Password must be at least 6 characters',
  '最近订单': 'Recent orders', '新建入库': 'New inbound', '搜索单号或客户': 'Search orders or customers', '只看逾期': 'Overdue only', '只看今日': 'Today only', '已导出': 'Exported', '导出': 'Export',
  '单号': 'Order ID', '客户': 'Customer', '件数': 'Items', '状态': 'Status', '时间': 'Time', '新建入库单': 'New inbound order', '异常告警': 'Alerts', '追踪': 'Trace',
  '订单详情': 'Order details', '关闭': 'Close', '追踪异常': 'Trace issue', '标记已发货': 'Mark shipped', '待拣货': 'Awaiting pick', '拣货中': 'Picking', '已发货': 'Shipped', '异常': 'Issue',
  '供应商': 'Supplier', '采购单号': 'Purchase order', 'SKU 编码': 'SKU code', '数量': 'Quantity', '已抽检': 'Sample checked', '需要冷链': 'Cold chain required', '备注': 'Notes', '取消': 'Cancel', '暂存': 'Save draft', '提交入库': 'Submit inbound', '确认入库信息': 'Confirm inbound details', '返回修改': 'Edit details', '确认提交': 'Confirm submission',
  '请选择供应商': 'Choose a supplier', '请输入采购单号': 'Enter a purchase order number', '请输入大于 0 的数量': 'Enter a quantity above 0', '请输入 SKU 编码': 'Enter a SKU code', '至少填写一行 SKU 和数量': 'Enter at least one SKU and quantity',
  '物流网络 · 徐州': 'Logistics network · Xuzhou', '仓库': 'Warehouse', '门店': 'Store', '货源充足': 'In stock', '偏紧': 'Low stock', '缺货': 'Out of stock',
  '滚轮缩放 · 左键平移 · 右键/Shift 旋转 · 悬停查看地点': 'Wheel zoom · left drag pan · right drag/Shift rotate · hover for details',
  '仓储孪生 · 徐州一号仓': 'Warehouse twin · Xuzhou 1', '俯视': 'Top', '斜视': 'Angled', '正视': 'Front', '只显示低库存': 'Low stock only', '拖动旋转 · 悬停查看库位': 'Drag to rotate · hover over a bin',
  '空闲': 'Free', '正常': 'Normal', '繁忙': 'Busy', '满载': 'Full', '库位': 'Bin', '在库': 'On hand', '缺货 SKU': 'Out-of-stock SKU', '入库': 'Inbound', '出库': 'Outbound',
  '订单异常': 'Order issue', '关联路线': 'Related route', '异常库位': 'Affected bin', '一条进入徐州一号仓的补货线路已逾期，可继续排查库位。': 'A replenishment route into Xuzhou Warehouse 1 is overdue. Inspect the bin next.', '查看关联路线': 'View related route', '定位异常库位': 'Locate affected bin', '返回订单': 'Back to orders',
  '库存台账 · 徐州一号仓': 'Inventory · Xuzhou Warehouse 1', '从库区概况定位到具体库位': 'Explore zones down to individual bins', '查看仓储孪生': 'View warehouse twin', '在库件数': 'Units on hand', '六个库区': 'Six storage zones', '待核查库位': 'Bins to inspect', '占用率低于 30%': 'Below 30% occupancy', '库位利用率': 'Bin utilization', '库区分布': 'Stock by zone', '在库件数 · 同一比例尺': 'Units on hand · same scale', '按低库存优先': 'Lowest stock first', '搜索库位或商品': 'Search bins or products', '没有匹配的库位': 'No matching bins',
  '管理仓库提醒、显示效果与当前账户。': 'Manage warehouse alerts, display, and your account.', '工作提醒': 'Work alerts', '选择需要及时处理的仓储事件。': 'Choose the warehouse events that need prompt attention.', '逾期提醒': 'Overdue alerts', '低库存预警': 'Low stock alerts', '每日报表邮件': 'Daily report email', '显示效果': 'Display', '调整动态效果与玻璃界面的渲染质量。': 'Adjust motion and glass rendering quality.', '减少动态效果': 'Reduce motion', '关闭视差与背景动画': 'Turn off parallax and background animation', '高': 'High', '中': 'Medium', '低': 'Low', '账户': 'Account', '更新当前用户的显示名称或登录状态。': 'Update your display name or sign-in state.', '显示名称': 'Display name', '修改密码': 'Change password', '退出登录': 'Sign out', '新密码': 'New password', '确认新密码': 'Confirm new password', '保存': 'Save', '退出后将返回登录界面。': 'You will return to the sign-in screen.',
  '云仓 WMS · 徐州一号仓': 'Cloud Warehouse WMS · Xuzhou 1', '自动刷新': 'Auto refresh', '今日': 'Today', '本周': 'This week', '本月': 'This month', '峰值': 'Peak', '工作日日均': 'Weekday average', '休息日日均': 'Day-off average', '  较昨日': '  vs yesterday', '近 14 天出库热力': 'Outbound heatmap · last 14 days', '库区 × 品类 库存': 'Stock by zone × category', '高：件数 · 色：周转天数': 'Height: units · color: days of cover', '周转': 'Cover',
  '库存 SKU': 'Stocked SKUs', '今日出库单': 'Outbound orders today', '准时发货率': 'On-time dispatch', '食品': 'Food', '饮料': 'Drinks', '日化': 'Personal care', '家居': 'Home', '数码': 'Electronics', '母婴': 'Baby',
  '单': 'orders', '件': 'units', '天': 'days', '单/时': 'orders/h', '单位：单/时': 'Unit: orders/h', '至': 'to', '2026年10月15日 周四': 'Thu, Oct 15, 2026',
  '个仓库': 'warehouses', '家门店': 'stores', '家供应商': 'suppliers', '在途': 'in transit', '逾期': 'overdue', '万件': '×10k units',
  '排': 'rows', '利用率': 'utilization', '占用率': 'Occupancy', '应拣': 'Required', '实际': 'actual', '当前': 'currently', '少于订单所需': 'below order requirement', '邮箱地址': 'Email address', '密码': 'Password',
  '王敏': 'Min Wang', '徐州': 'Xuzhou', '上海': 'Shanghai', '浙江': 'Zhejiang',
  '禾谷生鲜': 'Hegu Fresh', '星河超市·黄楼店': 'Xinghe Market · Huanglou', '青禾母婴': 'Qinghe Baby', '优格家居旗舰店': 'Youge Home Flagship', '蓝鲸日化': 'Blue Whale Care', '鹿野咖啡': 'Luye Coffee', '北辰数码': 'Beichen Digital', '木子文具': 'Muzi Stationery',
  '贾汪中转仓': 'Jiawang Transit Warehouse', '禾丰供应链': 'Hefeng Supply Chain', '鼎沃贸易': 'Dingwo Trading',
  '待处理': 'Pending', '入库单': 'Inbound order', '已提交': 'submitted', '定位': 'Locate', '个库位': 'bins', '渲染质量': 'Rendering quality',
  'AGV-01 运行中': 'AGV-01 running', ' · 今日搬运 412 次': ' · 412 moves today',
  '云龙区': 'Yunlong District', '鼓楼区': 'Gulou District', '泉山区': 'Quanshan District', '铜山区': 'Tongshan District', '贾汪区': 'Jiawang District', '新沂市': 'Xinyi City', '邳州市': 'Pizhou City', '丰县': 'Feng County', '沛县': 'Pei County', '睢宁县': 'Suining County',
  '大吴店': 'Dawu Store', '下淀店': 'Xiadian Store', '黄楼店': 'Huanglou Store', '王陵店': 'Wangling Store', '琵琶店': 'Pipa Store', '华山店': 'Huashan Store', '湖滨店': 'Hubin Store', '新城区店': 'New City Store', '潘塘店': 'Pantang Store', '金山桥店': 'Jinshanqiao Store', '大学城店': 'University Town Store', '矿大店': 'Mining University Store', '翠屏山店': 'Cuipingshan Store', '大郭庄店': 'Daguozhuang Store', '柳新店': 'Liuxin Store', '贾汪店': 'Jiawang Store', '龙固店': 'Longgu Store', '丰县店': 'Feng County Store', '沛县店': 'Pei County Store', '睢宁店': 'Suining Store', '新沂店': 'Xinyi Store', '邳州店': 'Pizhou Store', '官湖店': 'Guanhu Store', '双沟店': 'Shuanggou Store',
  '每日坚果 750g': 'Mixed nuts 750g', '燕麦片 1kg': 'Oats 1kg', '五常大米 5kg': 'Wuchang rice 5kg', '橄榄油 1L': 'Olive oil 1L', '苏打饼干 400g': 'Crackers 400g', '黑芝麻糊 600g': 'Black sesame powder 600g', '红枣 500g': 'Red dates 500g', '海苔 40g×10': 'Seaweed 40g×10',
  '矿泉水 550ml×24': 'Mineral water 550ml×24', '无糖绿茶 500ml×15': 'Unsweetened green tea 500ml×15', '苏打水 330ml×24': 'Sparkling water 330ml×24', '燕麦奶 1L×6': 'Oat milk 1L×6', '冷萃咖啡 270ml×12': 'Cold brew 270ml×12', '椰子水 1L×6': 'Coconut water 1L×6', '乌龙茶 500ml×15': 'Oolong tea 500ml×15',
  '洗衣凝珠 52 颗': 'Laundry pods 52 ct', '洗发水 750ml': 'Shampoo 750ml', '沐浴露 1L': 'Body wash 1L', '抽纸 3 层×24 包': 'Tissues 3-ply×24', '洗洁精 1.5kg': 'Dish soap 1.5kg', '牙膏 120g×3': 'Toothpaste 120g×3', '洗手液 500ml': 'Hand soap 500ml',
  '收纳箱 55L': 'Storage box 55L', '保温杯 500ml': 'Insulated bottle 500ml', '真空压缩袋 8 件': 'Vacuum bags 8-pack', '衣架 20 只装': 'Hangers 20-pack', '密封罐 6 件套': 'Storage jars 6-piece', '浴室防滑垫': 'Non-slip bath mat', 'LED 台灯': 'LED desk lamp',
  '纸尿裤 L 码 54 片': 'Diapers L 54 ct', '婴儿湿巾 80 抽×6': 'Baby wipes 80×6', '奶瓶 240ml': 'Baby bottle 240ml', '婴儿洗衣液 1L': 'Baby detergent 1L', '辅食米粉 250g': 'Baby rice cereal 250g', '儿童牙刷 4 支': 'Kids toothbrushes 4-pack',
  '蓝牙耳机': 'Bluetooth earbuds', '65W 快充充电器': '65W fast charger', '数据线 1m×2': 'Charging cables 1m×2', '移动电源 10000mAh': 'Power bank 10000mAh', '无线鼠标': 'Wireless mouse', '智能手环': 'Fitness band', '手机支架': 'Phone stand',
}

/** Localize sample-data labels without changing IDs or the underlying demo calculations. */
export function translateSpatialText(text: string): string {
  if (EN[text]) return EN[text]
  if (text.startsWith('星河超市 · ')) return `Xinghe Market · ${translateSpatialText(text.slice(7))}`
  if (/^[←→] /.test(text)) return text.replace(/(\d+) (家门店|个仓库|家供应商)/g, (_, count: string, kind: string) => `${count} ${EN[kind]}`).replace(/ 件$/, ' units').replace(/、/g, ', ')
  return text
    .replace(/^C 区 (\d+) 个库位满载$/, 'Zone C: $1 bins full')
    .replace(/^占用率已达 95% 以上，建议将慢动销 SKU 调拨至 F 区$/, 'Occupancy exceeds 95%. Move slow-moving SKUs to Zone F.')
    .replace(/^订单 (\S+) 拣货异常$/, 'Picking issue on order $1')
    .replace(/^库位 (\S+) 实际 (\d+) 件，少于应拣 (\d+) 件，已通知盘点$/, 'Bin $1 has $2 units, below the $3 needed. Stock check requested.')
    .replace(/^当前任务完成后自动返回充电位$/, 'Will return to charge after the current task.')
    .replace(/^AGV-02 电量 18%$/, 'AGV-02 battery 18%')
    .replace(/^([A-F]) 区$/, '$1 Zone')
    .replace(/^(\d+) 时$/, '$1 h')
    .replace(/^(\d+) 分钟前$/, '$1 min ago')
    .replace(/区$/, ' District')
    .replace(/店$/, ' Store')
}
