# 通用 UI 设计系统 · 月下墨金 v01

2026-11-06 建立，2026-11-11 更新。适用于《影刃疾行》的局外、局内及后续扩展界面。本版交付 **10 张概念设计板、通用控件目录、界面模板与状态规范**，已获用户概念审核通过（`approved`）。已迁移商店、设置、行前准备、关卡选择完整布局、暂停 / 结算通用面板及完整战斗 HUD；61 类目录不等于全部实现，当前覆盖见第 10～14 节，运行时视觉与 Android 另行验收。

[浏览全部设计](../art/concepts/ui/common/v01/README.md) · [离线图册](../art/concepts/ui/common/v01/index.html) · [任务卡与验收](../art/validation/ui/common/v01/README.md) · [机器可读设计参数](../art/concepts/ui/common/v01/design_tokens.json)

## 1. 复用约定

后续 UI 开发先查本目录：已有类型直接复用；新增需求先组合已有控件，再扩展已有变体；只有语义或结构确实不同才增加通用类型，同时补齐状态、规范与审核记录。不得在单个页面复制一套按钮、面板、颜色或冷却逻辑。

本规范是后续统一建设的设计依据。用户于 2026-11-06 明确回复“可以审核通过按照这个来吧”，按 [UI 工作流](UI_DESIGN_WORKFLOW.md) 分切片制作；现有商店、地图、悬浮 HUD 的历史审核记录继续保留。通用主题的审核不能替代具体新界面的构图审核，也不能把当前已接入界面改记为本版运行时验收通过。

**数据和规则优先于概念图中的文字。** 所有示例价格、成绩、角色立绘、库存和状态只用于展示容器。实际字段从注册表、目录、档案、`RunLoadout` 和运行时读取，不从图片识别或硬编码。

## 2. 视觉语言

“月下墨金”沿用月下雾岭、墨影与机关：大面积低纹理墨蓝，清楚的月白信息，少量暖金交互重点，朱砂提示伤害和风险。月弧、驿灯、短云纹只作为小面积装饰，场景负责氛围，控件负责阅读和操作。

- 主按钮为低纹理哑金填充、墨色文字；次按钮为墨底细金边；低优先级动作使用文字 / 图标入口。
- 面板使用单层细边与小转角，标题下最多一处短笔触；不叠加多重厚金框、密集云纹或持续外发光。
- 已选中用金色角标 / 边线，键盘焦点用第二道清晰轮廓；已装备另有勾选与文字，不能用选中代替装备。
- 朱砂不作为普通返回按钮的常态色。只有“放弃当前挑战”等确有损失的确认动作才用危险变体；按钮必须写明动作。
- HUD 使用透明悬浮布局；菜单使用低透光面板。二者共用字体、图标、色彩和状态，不强迫采用同一信息密度。

### 色彩与字体

| Token | 值 | 用途 |
| --- | --- | --- |
| `ink` | `#111827` | 全屏遮罩基色、深面板 |
| `surface` | `#192536` | 卡片、表单、菜单内容 |
| `surface_raised` | `#233448` | 悬停、轻抬升面 |
| `text_primary` | `#DDE7E7` | 正文、功能图形 |
| `text_secondary` | `#9AAEB8` | 辅助说明，不能承担唯一的关键条件 |
| `accent` | `#D8B56A` | 主动作、选中、可用、奖励 |
| `accent_light` | `#F0D39B` | 焦点、标题局部高亮 |
| `danger` | `#B24B4B` | 生命、受击、失败和风险边线 |
| `danger_text` | `#F1AAA1` | 暗底风险文字，避免深红小字 |
| `disabled` | `#73818D` | 不可操作状态；具体原因另用正文展示 |
| `border_neutral` | `#526372` | 中性分隔、未选中边界 |

规范值为准；01 图色板存在模型文字偏差，朱砂采用 `#B24B4B`，不用图中误写的色号。

正文与功能文字沿用 `fonts/NotoSansCJKsc-Regular.otf`。标题可另加少量书写笔触作为独立装饰，功能文字不换书法字体，不把标题中文烘焙到面板纹理。数字使用该字体并保留固定列宽，计时可用等宽数字特性或预留最大宽度。

| 文字角色 | 设计字号 / 行高 | 使用边界 |
| --- | --- | --- |
| 品牌标题 | 40 / 52 | 只用于标题页 |
| 页面标题 | 34 / 46 | 一屏一个 |
| 区块标题 | 26 / 36 | 详情、卡片标题 |
| 主按钮 | 22 / 30 | 短动作，通常 2～6 个汉字 |
| 正文 | 20 / 30 | 主要说明、条件 |
| 次正文 | 18 / 27 | 列表、状态 |
| 辅助 | 16 / 24 | 注释；关键条件不压缩到此字号以下 |
| 关键数值 | 32 / 40 | 分数、奖励摘要；单位降一级 |

### 尺寸、材质与图标

- 间距采用 `4 / 8 / 12 / 16 / 24 / 32 / 48`。页面左右基准边距 48，区块间距 24，面板内距 24，相关字段间距 8～12。
- 普通主按钮基准 216×56，次按钮 160×52；长文字可扩宽。工具图标视觉 24～28，命中区至少 48×48。
- 列表行 64 起，商品行 144 起，信息卡不强行等高；长说明增高或滚动，不直接缩小全页字体。
- 小转角基准 6，局部切角装饰 8；边线 1，选中 / 焦点 2。切角和装饰不缩小有效命中区。
- 图标使用月白实形或统一线宽 2 的简化轮廓；同一功能不混用不同画法。24 / 32 / 48 为工具图标档位，物品主体 64 / 96，原始位图不得无条件放大。
- 跳跃、翻绳、身法、武器、忍术必须各自可辨。武器和身法图标读取实际配置，不能所有角色都用奔跑图标，也不能贯星矛复用弦月轮。
- 圆按钮底板、图标、冷却扇形、弧线、数值、标题相互分离。名称在圆外，不再用实心小牌遮住图标。
- 大面板的装饰纹理只在边角出现，正文区域保持低纹理。素材需要九宫格拉伸时保留中心留白，纹理不带文字 / 数值。

## 3. 基础控件目录

以下为设计类型与预期接口，不表示已新增同名脚本。对应 [01 基础控件](../art/concepts/ui/common/v01/01_foundations.png) 和 [10 状态反馈](../art/concepts/ui/common/v01/10_feedback_states.png)。

| 类型 ID | 变体与设计 | 动态内容 / 交互 |
| --- | --- | --- |
| `action_button` | primary / secondary / quiet / danger | 文案、前置图标、可用原因、忙碌；最少保留一个清楚主动作 |
| `icon_button` | 返回、关闭、暂停、设置、展开 | 辅助名称、48 命中、清楚焦点；无文字时仍有语义名 |
| `tab_bar` | 横向下划线页签 / 等宽分段 | 当前项、可用项；超长横向滚动；切换不提交交易 |
| `category_rail` | 左侧分类，角标 + 标签 | 选中项、锁定原因；不要只靠填色 |
| `select_field` | 下拉、角色 / 模式筛选 | 当前值、可选项、空结果；弹出选择列表适合触摸 |
| `toggle_row` | 开 / 关 / 禁用 / 保存中 | 名称、可选说明；整个标签行可点击 |
| `check_row` | 未选、已选、不可选 | 重新携带、偏好；不要把静态“已保存”画成可点击复选框 |
| `radio_group` | 单选项组 | 明确唯一项；如“不携带 / 护身符 / 回春药” |
| `slider_row` | 连续值 / 有刻度 | 仅为后续有真实数值设置时预留；不替代当前四个开关 |
| `stepper` | 减 / 数值 / 加 | 数量、最小 / 最大、校验；当前商店单件购买不提前加批量购买 |
| `text_field` | 普通、搜索、多行 | 提示、编辑值、清除、校验；软键盘弹出时保留提交 / 返回入口 |
| `scroll_list` | 单列、多列、空数据 | 选中、焦点、滚动位置；不能靠细滚动条作为唯一触摸方式 |
| `page_control` | 上一页 / 页码 / 下一页 | 目录 / 图鉴长内容；边界禁用 |
| `section_header` | 标题、短说明、可选动作 | 装饰与文字分离；不为每个标题套一层大框 |
| `surface_panel` | flat / raised / inset | 公用间距与内容槽；尺寸由内容决定 |
| `divider` | 细线 / 短金线 | 只做分组，不接收输入 |
| `status_chip` | 已选、拥有、装备、携带、锁定、待保存 | 图形 + 文案；不同语义可并存 |
| `value_pair` | 名称 + 右对齐值 + 单位 | 价格、库存、成绩、前后对比 |
| `linear_meter` | 生命、加载、伤害占比 | 当前 / 最大；加载未知时用不定动画，不伪造百分比 |
| `radial_meter` | 冷却、身法剩余额度 | 比率与数值；不独立计时，只读运行时 |
| `star_rating` | 0～3，历史 / 本局 | 明确填充与空心，不从旧评级推算 |
| `flawless_seal` | 未获得 / 本局获得 / 历史获得 | 与三星独立；说明范围，不让历史印冒充本局无伤 |
| `progress_rail` | 路线段落 / 章节里程碑 | 节点和状态来自目录；不把 6 / 10 / 15 固定在控件内 |
| `portrait` | 圆形 HUD / 卡片头像 | 配置图、锁定 / 出战角标；候选立绘不顶替正式角色 |

## 4. 组合控件目录

对应 [02 组合组件](../art/concepts/ui/common/v01/02_composites.png)，以基础控件组成，不另起视觉语言。

| 类型 ID | 内容与状态 | 复用位置 |
| --- | --- | --- |
| `screen_header` | 返回、标题、上下文、可选余额 / 工具 | 地图、商店、手册、纪录 |
| `action_footer` | 上下文摘要、一个主动作、至多两个次动作 | 准备、地图、结算、详情 |
| `character_card` | 头像、名字、身法摘要、选择 / 所有权 / 出战 | 准备、解锁详情 |
| `equipment_card` | 图片、名字、预览 / 装备、简短属性 | 武器、秘卷；点按仅预览，装备另行确认 |
| `inventory_slot` | empty / item / locked；数量角标 | 物品网格、补给携带；“+”是空槽示意，不自动表示购买 |
| `level_card` | 缩略图、名字、星级、无伤、解锁、选中 | 地图；锁定项仍可查看具体前置 |
| `product_row` | 商品图、效果、价格、档位 / 库存、锁定原因 | 商店；成长不显示消耗品库存 |
| `detail_panel` | 标题、图片、描述、属性对比、操作槽 | 角色、物品、关卡、成长 |
| `ability_row` | 图标、能力名、简述、详细说明入口 | 准备、暂停；局内不长篇常驻 |
| `record_list` | 模式 / 角色筛选，值与快照入口 | 关卡、历史页 |
| `run_snapshot` | 关卡、模式、时间、角色、武器、成长、携带、规则版本 | 纪录详情抽屉；旧字段缺失如实写“未记录” |
| `stats_group` | 分数、收集、受击、用时、击破、连击 | 结算；不同模式按数据选字段 |
| `damage_breakdown` | 武器 / 忍术 / 飞镖，数值 / 占比 | 首领结算；没有伤害数据不画伪占比 |
| `reward_row` | 项目、金额、已提交 / 待保存、去重状态 | 奖励明细；动画不发钱 |
| `milestone_track` | 条件、进度、可领 / 已领 / 未满足 | 章节奖励；只展示服务已算出的权益 |
| `loadout_summary` | 当局角色 / 武器 / 秘卷 / 补给 | 底栏、暂停、确认、快照 |
| `carry_picker` | 不携带 / 可用补给，库存、默认不续带 | 商店、未来重试页；选择不扣库存 |
| `combat_action` | 图标、按下、资格、冷却、额度、动态名称 | 一左四右；复用 `RunInput` 语义 |
| `passive_item_chip` | 未携带 / 待触发 / 已触发 / 已用尽 | HUD、暂停；不增加第六个操作键 |
| `boss_status` | 生命、护甲 / 弱点 / 强化、阶段倒计时 | HUD 顶部；状态互斥关系由首领运行时决定 |
| `threat_notice` | 方向形状、侧别、动作、剩余时间 | HUD 与场内预警配合；不能只靠红 / 金颜色 |

## 5. 弹层与系统状态

对应 [07 弹层](../art/concepts/ui/common/v01/07_overlays.png)、[08 结算](../art/concepts/ui/common/v01/08_results.png)、[10 轻反馈](../art/concepts/ui/common/v01/10_feedback_states.png)。

| 类型 ID | 规则 |
| --- | --- |
| `modal_shell` | small 480 / medium 720 / large 960 宽，最大高度为安全框减 96；固定头尾，中部可滚动 |
| `confirm_dialog` | 明确对象、花费、变化、余额；“取消”在左，“确认动作”在右；初始焦点取消，提交重查数据 |
| `leave_run_dialog` | 说明当前挑战不会记为通关；危险主动作写“放弃挑战”，安全动作“继续挑战” |
| `settings_dialog` | 复用四个真实开关，变化立即生效、独立保存状态；扩展数值设置时才使用滑杆 |
| `pause_panel` | 继续最突出，展示当局只读配置；设置、重试、返回清楚分组 |
| `detail_drawer` | 长纪录 / 物品 / 规则信息；可滚动，有显式关闭；移动端点按可达 |
| `tooltip` | 桌面悬停 / 焦点短说明；触屏点击信息键进入 popover，不依赖长按才可见 |
| `toast` | 成功 / 信息 / 轻警告，最多两条；不拦输入，不承担保存失败的唯一提示 |
| `section_announcement` | 关卡 / 段落短标题，安全时段显示；复杂操作时不弹长台词 |
| `unlock_notice` | 展示服务返回的解锁结果；“查看”路由存在才显示，不触发重复发放 |
| `empty_state` | 图形、具体原因、可执行下一步；尚无纪录、筛选无结果、内容待开放分别写 |
| `loading_state` | 短过渡优先轻提示；未知进度用月弧 / 不定条；超时 / 失败出现重试与返回 |
| `save_notice` | 已保存、保存中、待保存、备份恢复、未来版本只读；持续标识与重试，不随 toast 消失 |
| `validation_notice` | 就近显示锁定、余额不足、满级、库存满、字段错误；按钮旁说明原因 |
| `dialogue_box` | 说话人、短对话、继续 / 跳过；自动、回看仅在功能实现后显示 |
| `tutorial_callout` | 单步目标、指向对象、进度 / 跳过；仅在安全的教学上下文中暂停或引导 |

弹层显示时阻断底层输入，焦点只在当前弹层循环。设置可作为暂停的子页，关闭后回到原暂停状态；交易确认不与另一个确认叠在一起。`Esc / 返回` 先处理最内层，不能一键穿透返回场景。关闭、取消、失败、失焦和场景切换均清理输入与按下态。

忙碌按钮保留原尺寸，显示动作和转圈，拦重复提交。禁用理由就近可读；不要把唯一原因藏进 hover。普通信息弹层可外点关闭；交易、放弃挑战、待保存异常需要明确动作，不用外点自动确认。

保存失败不重新计算奖励或交易；正式挑战 / 正式奖励重试按现有服务阻断，免费练习可用。较新版本档案显示只读，不承诺通过“重试保存”覆盖它。

## 6. 完整界面模板

| 模板 | 概念板 | 组成与重点 | 当前功能边界 |
| --- | --- | --- | --- |
| 行前准备 / 角色选择 / 装备 | [03](../art/concepts/ui/common/v01/03_preparation.png) | 页头 + 角色列 + 预览 + 装备详情 + 操作底栏 | 武器准备已有；正式角色选择、专属立绘待开发 |
| 章节 / 关卡 / 纪录详情 | [04](../art/concepts/ui/common/v01/04_journey.png) | 关卡列表 + 驿灯路线 + 详情 / 纪录 + 挑战底栏 | 两关、驿灯路线与触摸快照已有；故事待开发 |
| 商店 / 成长 / 秘卷 / 补给 | [05](../art/concepts/ui/common/v01/05_shop.png) | 分类列 + 商品列表 + 详情 + 携带摘要 | 独立商店已有；外观只用空状态 |
| 背包 / 装备网格 | [02](../art/concepts/ui/common/v01/02_composites.png) | 分类 + `inventory_slot` 网格 + `detail_panel` | 仅模板；不新增材料 / 合成 / 装备稀有度系统 |
| 战斗 HUD / 首领 HUD | [06](../art/concepts/ui/common/v01/06_combat.png) | 悬浮信息 + 路线进度 + 互斥首领状态 + 一左四右 + 被动道具 | 全部现有 HUD 已迁移通用组件，读取真实冷却 / 额度 / 补给；用户视觉 / Android 待验收 |
| 暂停 / 设置 | [07](../art/concepts/ui/common/v01/07_overlays.png) | 同一弹层壳，主要按钮与只读能力列表 | 通用主题 / 暂停面板已接入，运行时用户视觉 / Android 待验收 |
| 购买 / 退出 / 错误确认 | [07](../art/concepts/ui/common/v01/07_overlays.png) | 小弹层、具体变更、明确取消 / 提交 | 购买确认已有；统一异常容器待接入 |
| 成功 / 失败 / 重试 / 奖励 | [08](../art/concepts/ui/common/v01/08_results.png) | 成绩主评、独立无伤、统计、奖励详情、重试底栏 | 通用结算面板已接入；重试显式再次携带、伤害占比图待开发 |
| 标题 / 制作名单 | [09](../art/concepts/ui/common/v01/09_story_help.png) | 大场景、品牌、一个主入口、次级设置；名单复用长列表 | 仅模板；当前正式入口仍是准备页 |
| 剧情 / 回看 | [09](../art/concepts/ui/common/v01/09_story_help.png) | 场景 / 立绘 + 对话框；长文本进入回看列表 | 仅模板，故事系统未实现 |
| 教学 / 手册 / 图鉴 | [09](../art/concepts/ui/common/v01/09_story_help.png) | 安全教学提示；分类 + 搜索 + 图文详情 | 仅模板；不在普通跑酷中弹交互长窗 |
| 加载 / 空态 / 只读 / 保存异常 | [10](../art/concepts/ui/common/v01/10_feedback_states.png) | 共用状态面板、持久提示、重试 / 返回 | 状态设计；仅绑定真实已有能力，不伪造加载进度 |

不为在线账号、聊天、公会、抽卡、广告复活、战令或多币种专门设计首版页面；项目没有这些系统。以后若有明确需求，扩展本体系，而非先接入无业务支撑的入口。

## 7. HUD 与屏幕适配

沿用 1280×720、`ScreenLayout.safe_rect()` 和 `fit_frame()`。菜单核心内容保持比例；宽屏扩展背景和合理空白，不把卡片横向拉长。窄安全框下优先减少列数、变为“列表 → 详情”切换、正文滚动，主动作仍固定在安全区内。

局内继续使用真实钢索 `Y=490`、角色上下身位和既有 `TouchControls` 布局。视觉约 96 的操作键拥有独立命中区；左翻绳，右下身法 / 跳跃，右上武器 / 忍术，保留现有错位与间隔。不得为了匹配概念图移动钢索、判定、相机或操作语义。身法适配点按 / 按住 / 松开，暂停、失焦、失败和切场景释放全部触摸。

顶部采用已确认的悬浮式 HUD：头像 + 朱砂细生命条，独立影晶与时间，右侧细进度和暂停；无总底板。首领信息在上方空位，长能力说明进入暂停。动态预警不能遮住高跳、弹道间隙或角色下侧。

至少核对 1280×720、1600×720，以及 `Rect2(60,24,1480,648)` 模拟安全区；后续补真实 Android。设计命中区 ≥48、局内按键基准 96，仍须在最终设备缩放下检查手指遮挡和实际大小，不把设计 px 等同于物理像素或 dp。

### 状态与动效

- 按钮提供 normal、hover、pressed、focus、disabled、busy；hover 只做桌面增强，触摸不依赖它。
- 点按反馈约 80ms；颜色 / 描边切换 120ms；弹层淡入 160ms；toast 约 2.4 秒。减少动态时退化为即时状态，不循环闪光。
- 就绪只做一次短亮；按下内缩不超过 2%，不移动命中区。焦点轮廓不被按下态覆盖。
- 冷却数值使用实际剩余秒数，最后 2 秒按既有精度显示；扇形和恢复弧的方向固定，额度与冷却分开。
- 关键变化不能只靠颜色、音效或震动。生命、警告、无伤、锁定均有形状 / 字段配合。
- 长名称先换行 / 提供详情，不截断价格、锁定原因和主动作；切换 Tab 保留筛选及滚动位置。

## 8. Godot 制作与扩展方案

本节是审核通过后的实现契约；首批实现遵循下列约定，不为尚未实现的目录项创建空脚本 / 空场景占位。

1. **先统一主题。** 扩展现有 `PaintedTheme`，从语义 token 建立 Theme / StyleBox 变体，兼容现有字体入口；组件拿语义值，页面不写十六进制颜色。
2. **再做可组合控件。** 计划按需放入 `scripts/ui/components/`、`scenes/ui/components/`；简单 Label / 容器无需一一建立场景。采用 `variant / density / state / title / icon / disabled_reason` 等稳定属性，`pressed / selection_changed / close_requested` 等信号。
3. **页面只组装与绑定。** 业务由 `PlayerProfile`、`EconomyService`、`RewardService`、`LevelCatalog`、`RunNavigation` 和运行时提供；控件不扫描文件夹，不直接改余额，不写共享 `.tres`，不按具体角色 ID 特判。
4. **状态由数据驱动。** 推荐输入 `id / title / description / icon / selected / owned / equipped / locked_reason / values / actions` 的显示模型。`selected` 与 `equipped`、`pending` 与 `saved` 是独立字段，不用一个布尔值兼任。
5. **素材按需制作。** 矩形、描边、圆弧、文字、数值、遮罩和焦点用 Godot；候选纸纹、短笔触、状态图形、物品图标经审核制作并保留来源。圆角 / 切角装饰不要求每种状态一张整图。
6. **扩展先登记。** 增加新变体需要说明适用位置、与原类型的差异、必需状态、动态字段、主题 token、输入与适配边界。需要新的视觉语法时升级版本，不在页面内偷加第三种主按钮。

建议制作切片：基础主题 / 按钮 / 面板 → 弹层与系统状态 → 卡片 / 列表 / 详情 → 准备、商店、地图逐页迁移 → HUD 与结算 → 已获功能授权的剧情 / 教学等。每个切片可单独验证，不借统一 UI 一次性实现后续所有玩法。

## 9. 概念检查与验收

10 张原始图均由内置 `image_gen` 工具生成，逐字节保存，未用 CLI、放大、裁切或代码重绘冒充模型原图。图片定义视觉关系，正式制作前需要修正以下概念偏差：

| 概念板 | 制作时必须以规范 / 数据修正 |
| --- | --- |
| 01 | 朱砂色号误写；普通返回不能套危险变体；页签、按钮中文字改为原生字体 |
| 02 | 星形填充辨识偏弱；成长的满级 / 库存示例混排，实际按商品种类分别展示；背包示例不新增物品系统 |
| 03 | 岚织 / 烬锋立绘为构图候选；解锁条件读注册表；贯星矛“贯穿”只是模型用词，正式文案沿用当前技能定义 |
| 04 | `3 / 6` 仅为两关可达星数示意，不能改成章节总星数；总目标与里程碑取目录 / 服务，现设计章节目标 15 |
| 06 | 钢索位置和操作键几何存在生成偏差，严格用现有布局；把弱点 / 攻击预警视作不同状态示例，不能同时当作真实首领阶段 |
| 07 | 购买确认画在玩法背景上是弹层壳示例，实际只在商店显示；文字如“继续片战”须恢复“继续挑战” |
| 08 | `+80` 是排版示例，不是奖励公式；“已保存”用静态状态图标；再携带为后续功能，未实现不显示可操作入口 |
| 09 | 教学文案与尖刺上下侧未完全对应，实际必须使用同侧危险示例；剧情 / 回看 / 自动 / 搜索无功能时不提供伪按钮 |
| 10 | 加载条示例不是可测的真实进度；无进度接口用不定条；小视窗中的装饰摇杆不纳入本游戏 |

没有上述偏差的其他细节也需在实际 1280 / 宽屏截图中确认。设计交付时已完成概念内容、原图结构 / 链接 / 导出边界检查；用户现已通过概念审核，首批组件实现与验证见下节。**用户运行时视觉与 Android 仍待后续**。

每次迁移按影响选择已有测试：触摸与 HUD 用 `touch_controls / ui_art_preview`；商店用 `economy`；地图用 `level_select`；结算与存档用 `save / stars_records / reward_transactions`。涉及当局装备加 `weapons`，无需为每个外观变体新建测试场景。自动、截图、用户、实机四类验收分开记录，任务卡为状态依据。

## 10. 首批原生控件与接入边界

2026-11-06，概念审核通过后开始制作。实现均为原生 Control / StyleBox / 绘制，不需要先制作新位图；概念图和设计 JSON 继续排除正式导出。

| 已实现入口 | 用法与覆盖 |
| --- | --- |
| `scripts/ui/ui_tokens.gd` · `UITokens` | 运行时语义色板、字号、间距、触摸尺寸；设计 JSON 为可核对的合同，运行时不加载它 |
| `scripts/ui/painted_theme.gd` · `PaintedTheme` | 共用 Theme、面板、按钮 normal / hover / pressed / disabled / focus 样式；旧入口保持兼容 |
| `scripts/ui/components/ui_action_button.gd` · `UIActionButton` | `variant` 为 primary / secondary / quiet / danger；`set_available(value, reason)`、`set_busy(value)`；忙碌不改变文字和命中区，阻止重复输入 |
| `scripts/ui/components/ui_toggle_row.gd` · `UIToggleRow` | 原生 Button 单行开关，`button_pressed / toggled / set_pressed_no_signal`；整行可触摸，位置与颜色共同表达开关 |
| `scripts/ui/components/ui_status_chip.gd` · `UIStatusChip` | `set_status(id, caption)`；selected / owned / equipped / carried / locked / pending / saved / readonly / error，图形由代码绘制；后续增加 preview、used 和 empty |
| `scripts/ui/components/ui_confirm_dialog.gd` · `UIConfirmDialog` | `configure(title, body, action_text, origin_control)`；confirmed / cancelled 信号；遮罩、长文滚动、固定操作区、取消初始焦点、焦点循环和关闭后恢复 |

商店已移除页面内独立按钮 / 面板样式；分类复用主题，商品保留统一焦点轮廓，购买复用 `UIConfirmDialog`，余额旁用持久状态标识显示待保存 / 只读。交易规则与重新报价检查继续由原服务负责。

准备 / 局内 / 暂停 / 结算的既有按钮和面板通过兼容入口取得共同基础样式；这只是基础样式迁移，不表示上述页面已完成概念板中的重新布局。设置面板复用统一开关、按钮、面板和保存状态，居中适配内容高度，遮罩阻断底层触摸；原有四项偏好和暂停生命周期保持一致。

首批完成时，角色选择、准备页改版、背包、长纪录详情、完整结果模板、HUD 新图标与被动道具、标题 / 剧情 / 教学等均未实现。准备页后续进度见第 11 节；其余继续按切片建设。既有图标和背景继续保留，后续新位图单独制作 / 验收。

验证复用 `tests/test_ui_components.gd`，无新 `.tscn`。该套件检查忙碌 / 可用状态、触摸、弹层遮挡与焦点、长文、主题合同；`--capture-dir=` 可捕获首批控件和正式界面。商店追加初始取消焦点回归；触屏套件追加设置遮罩防穿透。

```sh
godot_bin=/Applications/Godot_mono.app/Contents/MacOS/Godot
"$godot_bin" --headless --path . --fixed-fps 60 --log-file /tmp/ninja-ui-components.log --script res://tests/test_ui_components.gd
# 图形截图：省略 --headless，并追加
# -- --capture-dir=/绝对路径/截图目录
```

首批实际截图与本地回归摘要集中在 [任务卡](../art/validation/ui/common/v01/README.md)。图形回归和助手截图不替代用户运行时视觉 / Android 验收。

## 11. 第二批：卡片、页签与行前准备

2026-11-06，继续在已审核概念 02 / 03 上制作。正式入口仍为 `scenes/ui/character_setup.tscn`，F5 显示“行前准备”。本切片不增加正式角色选择和新玩法，只展示当前正式角色及真实装备。

| 已实现入口 | API 与复用边界 |
| --- | --- |
| `scripts/ui/components/ui_select_card.gd` · `UISelectCard` | `configure(id, title, description, texture)`；`set_state(selected, status, caption)`，继承原生 Button 的 pressed / disabled / focus。选中角标与装备 / 预览 / 锁定标识独立；锁定卡可查看。图片槽 72×72、基准高度 140，描述保持简短，长说明放详情。实例入树和尺寸变化时重排图片与文字，不让文字最小高度扩大图片槽 |
| `scripts/ui/components/ui_tab_bar.gd` · `UITabBar` | `set_entries([{id,title}], initial_id)`、`select(id, emit_change)`，`selection_changed(id)`。复用原生可聚焦按钮，下划线标记选中；重复点当前项不会取消唯一选中。当前覆盖少量等宽页签，超多页签的横向滚动尚未实现 |
| `scripts/ui/components/ui_detail_panel.gd` · `UIDetailPanel` | `set_description(title, body)`，公开 content / footer 槽、scroll；标题和底部操作固定，中部可滚动；空 footer 隐藏，正文不会挤掉操作区 |
| `UIStatusChip` 扩展 `preview` | “预览中”使用独立图形和文案；不以选中代替装备 |

准备页组合以上组件：

- 左侧只读当前角色卡和数据驱动的身法 / 忍术说明；复用已有正式头像，不放大候选角色立绘，也不提供未完成角色的出战入口。
- 右侧“武器 / 秘卷 / 补给 / 纪录”四页签；两张起始武器卡先预览，显式装备后保存。切换页签不改变预览、装备或库存。
- 武器详情保留描述、首领基础伤害、冷却、出招方式与攻击演示。秘卷 / 补给展示实际选择和库存，调整统一进入山路行商；准备页不复制购买或消费事务。
- “历史纪录”进入纪录页签，展示雾岭断桥三个模式的原有纪录；多关完整纪录继续从关卡选择查看，旧纪录不推算三星。
- 底部固定山路行商、历史纪录、免费练习与主要关卡入口。保存失败持续显示重试；较新档案允许查看，阻止装备写入，保持只读标识。
- 新的可聚焦控件要求设置面板管理键盘焦点：显示时焦点转到关闭，Tab / 方向键在内部循环，Esc 关闭后恢复来源焦点；触摸遮罩继续阻断底层。

这是概念 03 在当前功能范围内的布局：不保留三角色选择列和大立绘舞台，把空间给已可用的武器卡、详情及原有练习。标题、余额、装备 / 携带和纪录均为 Godot 动态文字；没有从概念图裁切生产素材。

回归继续复用 `tests/test_ui_components.gd`，增加真实触摸 / 键盘切页、反复选择、卡片图片与标识边界、预览 / 装备分离、状态保留、库存只读、历史空态和设置焦点恢复。`--capture-preparation-dir=` 捕获正式准备页的 10 种状态，无新测试场景。

```sh
/Applications/Godot_mono.app/Contents/MacOS/Godot --path . --fixed-fps 60 \
  --log-file /tmp/ninja-ui-preparation-render.log \
  --script res://tests/test_ui_components.gd -- \
  --capture-preparation-dir=/绝对路径/截图目录
```

实现 / 审核记录：[准备页任务卡](../art/validation/ui/character_setup/v01/README.md)。正式多角色选择、背包及剧情 / 教学仍待后续；地图触摸快照见第 15 节，不能把本切片记为 61 类组件全部完成。暂停 / 结算后续迁移见第 13 节，战斗 HUD 见第 14 节。

## 12. 第三批：关卡选择运行时控件迁移

2026-11-07，沿用已审核的关卡卡面和锁定图层，把正式 `scenes/ui/level_select.tscn` 的动态控件接入通用体系。本批只改运行时控件和状态表达，不替换关卡插图、路线背景或既有判定，不新增测试场景。

| 迁移位置 | 通用控件 / 主题 | 运行时边界 |
| --- | --- | --- |
| 返回、重试保存、开始挑战、进入练习、重看剧情、卡片命中区 | `UIActionButton` | quiet / secondary / primary 变体；保存重试使用安全恢复动作的 secondary，保留原有按钮字段和触摸命中区 |
| 全角色最高 / 当前角色 | `UITabBar` | 页签切换只读纪录视图，不提交交易；`_record_view_buttons` 保留兼容测试入口 |
| 铜钱与存档状态 | `UIStatusChip` | 待保存 / 当前只读持续显示；只读档案隐藏重试并阻止正式挑战，练习仍可进入 |
| 卡片标题遮罩、关卡说明背景 | `PaintedTheme.flat_style` | 动态文字继续由 Godot 绘制；锁定项仍可查看具体前置，已审核卡面绘制逻辑不变 |

关卡选择页继续从 `LevelCatalog`、`RunHistory`、`RunLoadout` 和 `PlayerProfile` 读取真实数据。选中与解锁、纪录与当前角色筛选、正式 / 练习模式保持独立；“待保存”提示不替代奖励或存档服务的阻断规则。

回归入口为 `tests/test_level_select.gd`、`tests/test_stars_records.gd` 与 `tests/test_reward_transactions.gd`；触屏和关卡美术影响时继续串行补跑 `tests/test_touch_controls.gd` 与 `tests/test_ui_art_preview.gd`。本批自动行为回归已通过，用户运行时视觉与 Android 实机仍按关卡任务卡单独验收。

2026-11-09 补齐 9 张实际截图，移除旧动作按钮 / 图标图层，避免与新文字重叠；动态文字统一读语义 token。余额只展示真实数值，待保存由独立状态标识表达，最大 10 亿余额不与状态重叠。旧贴图和历史证据保留。宽屏、安全区、锁定、只读与最大余额检查见[关卡 v02 任务卡](../art/validation/ui/level_select/v02/README.md)。

## 13. 第四批：暂停与结算通用面板

2026-11-09，适配已审核的概念 07 / 08，复用正式 `main.tscn` 及两个继承练习场景。没有新增位图或测试场景；`main.gd` 只保留流程、成绩、奖励数据绑定，布局与焦点移入共用组件。

| 已实现入口 | API 与复用边界 |
| --- | --- |
| `scripts/ui/components/ui_run_panel.gd` · `UIRunPanel` | 共用暂停 / 成功 / 失败 / 加载错误面板；入树后 `bind_labels(title, body)`，`set_pause_mode(value)`、`set_rating(stars, flawless, score)`、`reset_scroll()`；公开 `body_scroll`、当局配置、存档标识和原生动作按钮；以 resume / retry / setup / settings / rewards / save 信号交给业务处理 |
| `scripts/ui/components/ui_star_rating.gd` · `UIStarRating` | 只读 `stars` 为 0～3，原生填充 / 空心星形；不计算成绩，不推算旧纪录，不代表无伤；正式结算旁边始终有独立无伤文字与真实分数 |

面板 840×568，固定标题、配置、底部操作和存档状态；中部说明 / 奖励滚动，长内容不挤掉按钮。暂停把继续设为主动作；正式 / 练习 / 失败按原有流程展示内容，只有正式成功显示星级。存档失败保持状态，禁用新正式重试，保存成功恢复；只读不提供覆盖保存。重试仍默认不续带补给，没有预接入新的消费行为。

Tab / 方向键在当前动作中循环，暂停初始焦点继续，结算初始焦点重试，保存失败初始焦点保存重试；Enter 执行当前焦点，R 保留重试。设置子窗隐藏父面板、阻断后台暂停和重试，关闭恢复原暂停 / 结果与设置来源焦点。全屏遮罩覆盖宽屏和安全区外留白。

验证继续复用 `ui_components / touch_controls / ui_art_preview / mobility / save / stars_records / reward_transactions`，并运行完整本地回归。组件专项增加长文滚动、焦点、状态独立与保存重试验证，`--capture-run-dir=` 生成 11 种正式场景截图。具体证据、实际入口和验收状态集中在[暂停 / 结算任务卡](../art/validation/ui/run_overlay/v01/README.md)。用户运行时视觉 / Android 待验收，远端 CI 未运行。

## 14. 第五批：完整战斗 HUD

2026-11-09，按已审核的概念 06，将正式 `main.tscn` 及继承练习场景的生命、影晶、计时、进度、段落、战斗反馈、首领、威胁和动作展示迁入通用体系。移除旧卡片、隐藏的角色 / 忍术 / 武器面板及 `PaintedHUD / FloatingHUDMarks`；不保留另一套隐藏 HUD 供业务更新。

| 已实现入口 | API 与复用边界 |
| --- | --- |
| `scripts/ui/components/ui_linear_meter.gd` · `UILinearMeter` | `set_value(value, maximum, tint)`，生命 / 首领共用；非有限值和无效最大值按零显示，比率限制在 0～1 |
| `scripts/ui/components/ui_radial_meter.gd` · `UIRadialMeter` | `set_value(value, maximum, is_quota)`，只读实际冷却或剩余额度；额度另有圆点与“余 x.xs”文案，不在视图中计时 |
| `scripts/ui/components/ui_combat_action.gd` · `UICombatAction` | `set_state(snapshot, keyboard)`，组合动作图形、独立名称、资格原因、冷却 / 额度、按下态与键盘提示；武器图读取真实装备，身法图形按身法实现 ID 分派 |
| `scripts/ui/components/ui_boss_status.gd` · `UIBossStatus` | `set_state(snapshot)`，生命条和单一阶段提示；半血强化独立标注，不覆盖弱点或蓄力阶段 |
| `scripts/ui/components/ui_threat_notice.gd` · `UIThreatNotice` | `set_notice(text, side, urgent, active)`，侧别箭头、预警 / 动作 / 时间；安全段使用中性短线，避免误报 |
| `scripts/ui/components/ui_battle_hud.gd` · `UIBattleHUD` | `render(snapshot)`，组装透明悬浮 HUD、被动补给标识与桌面暂停入口；`pause_requested` 交给主流程，不处理玩法和消费 |
| `scripts/ui/battle_hud_presenter.gd` · `BattleHUDPresenter` | `snapshot / action_snapshot / threat_snapshot`，读取玩家、战斗与关卡状态；主场景只负责调用与信号绑定 |
| `ProgressRail` / `UIStatusChip` 扩展 | 路线节点由实际段长和首领所占进度生成；补给使用 empty / carried / used，区分未携带、待触发、已触发 |

顶部保留头像、朱砂细生命条、影晶 / 时间和路线进度，无总底板。保护时间取当前有效保护的最大剩余时间，不相加。正式全关延续路线 75% / 首领 25% 的进度规则；跑酷与首领练习各自使用完整进度，通关固定为 100%。节点来自关卡段长，不再固定画四等分。

`PaintedTouchControls` 继续继承原 `TouchControls` 输入与安全区布局，用六个 `UICombatAction` 展示一左四右及暂停。桌面显示同一套只读动作与快捷键，原生暂停按钮可点击；F3 / 移动设备启用原有触点输入。没有新增动作输入路径，也不改变钢索、碰撞、冷却、身法、按键命中区或多指生命周期。圆内展示状态，名称放圆外，去掉遮住图标的小实心牌；长能力说明仍在暂停。

补给只读 `RunLoadout` 的实际消费 ID 和玩家公开的触发状态，不按局外选择推测携带，不在 HUD 扣库存。普通重试仍不续带。御风显示本次离绳剩余额度，雷闪显示真实冷却，踏影显示当前使用条件。

没有新增位图、PSD 或测试场景。正式影刃头像继续复用；灰盒角色仍使用既有头像着色，专属正式头像 / 立绘不计为本次完成。候选触屏预览保留原图层评审用途，适配共同状态与文字组件；旧素材与历史证据保留。

`tests/test_ui_components.gd` 增加生命、暂停冻结、键盘显示、首领互斥阶段 / 强化、路线节点、身法额度 / 冷却及真实补给触发 / 不重复消费验证。`--capture-hud-dir=` 捕获 17 种正式场景状态，覆盖两关、桌面 / 触屏、1280 / 1600 / 模拟安全区、低血量、冷却、首领与补给。完整回归、截图和未完成人工项集中于[战斗 HUD 任务卡](../art/validation/ui/battle_hud/v01/README.md)；用户运行时视觉与 Android 实机待验收。

## 15. 第六批：关卡选择完整布局

2026-11-11，补齐已审核概念 04 的页面构图。第 12 节的 v02 只完成运行时控件迁移；本批正式页采用关卡列表、中央驿灯路线、右侧纪录详情和固定挑战底栏，解除旧整页分层拼装场景依赖，保留已审核的背景、插图和驿灯。

| 已实现入口 | API 与复用边界 |
| --- | --- |
| `scripts/ui/components/ui_level_card.gd` · `UILevelCard` | 扩展 `UISelectCard` 的横幅关卡变体；沿用 `configure`，`set_progress(unlocked, selected, record)` 只读解锁和纪录；组合 `UIStatusChip / UIStarRating`，不推算旧版星级 |
| `scripts/ui/components/ui_journey_route.gd` · `UIJourneyRoute` | `set_entries([{level_id,order,title,unlocked,selected,completed}])`，可选 `lantern_texture`，`level_selected(id)` 交给页面；节点来自目录，锁定节点可查看，连线不发奖 |
| 纪录与触摸快照 | `UIDetailPanel / UITabBar / UIConfirmDialog` 组合；最高分、最快、首次无伤保持各自单局数据，缺字段显示未记录；弹层关闭恢复来源焦点，阻断底层选择和启动 |

章节星数只相加真实正式星级；余额、前置条件、只读和待保存状态继续读取已有服务。背景铺满宽屏，所有交互由 `ScreenLayout` 适配安全框。旧拼装与原分层暂留作视觉对照，用户运行时视觉验收后按实际依赖清理；不覆盖历史证据。

入口、截图、回归与人工边界集中于[关卡 v03 任务卡](../art/validation/ui/level_select/v03/README.md)。本批无新位图或测试场景；用户运行时视觉 / Android 另行验收。
