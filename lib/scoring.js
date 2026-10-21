// dsh-tier-brain / 评分核心
// 纯函数，无 IO、无依赖：宿主（lib/index.js）与客户端共用同一份规则，
// 避免两份实现各自漂移。客户端不自己算分，一律 POST /dsh-tier-brain/preview。

// 档位与真实四档（off / low / high / max）的对应关系：
//   省 = Flash + off   —— 寒暄、查事实、格式转换。实测 off 首字 <0.1s、几乎零推理成本；
//                        而 low 并不是"便宜档"：源码里 low 不加任何提示，反而更容易漫游、更啰嗦。
//   平 = Flash + high  —— 日常读代码、改界面、写脚本。官方默认档，结构化提示让输出更收敛。
//   强 = Pro + high    —— 复杂调试、跨文件重构、架构取舍。
//   极难任务在"强"档内部自动升到 max（见 MAX_THRESHOLD），不新增第五个档位。
export const TIERS = {
  1: { key: '省', model: 'deepseek-flash', effort: 'off', color: '#22c55e' },
  2: { key: '平', model: 'deepseek-flash', effort: 'high', color: '#eab308' },
  3: { key: '强', model: 'deepseek-v4-pro', effort: 'high', color: '#ef4444' },
};

// max 只给"必须长链推导"的极少数类型，且门槛按类型分档：
// REVIEW 基准分本来就高，66 已代表"不只是看看"；ARCHITECTURE 到 72；
// DEBUG/REFACTOR 要到 76/78 才算真难。门槛故意偏高——max 实测常花 4 倍 token
// 换一样甚至更差的答案，宁可漏推，不可乱推。
export const MAX_THRESHOLD = { ARCHITECTURE: 72, REVIEW: 66, DEBUG: 76, REFACTOR: 78 };

/**
 * 高峰时段判断（北京时间）。
 * 官方口径：周一至周五（不含法定节假日）9:00–12:00、14:00–18:00 为高峰，
 * 其余时段（含周末）为空闲，同档价格减半。
 * 法定节假日无法在本地可靠判断，这里按"工作日"近似——提示只做省钱参考，
 * 不承诺精确到节假日，避免给出看似精确、实际会错的结论。
 */
export function peakOf(now = Date.now()) {
  const bj = new Date(now + 8 * 3600 * 1000);
  const day = bj.getUTCDay(); // 0 = 周日
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const workday = day >= 1 && day <= 5;
  const morning = minutes >= 9 * 60 && minutes < 12 * 60;
  const afternoon = minutes >= 14 * 60 && minutes < 18 * 60;
  return workday && (morning || afternoon);
}

// 任务类型基准分：这是"这件事本身有多难"的锚点，修饰项只做加减。
// 刻度：纯寒暄≈5，查一个事实≈12，解释概念≈20，改一处代码≈42，
// 排查未知原因≈46，设计架构≈66。
const BASE = {
  ACK: 5,
  FACT: 12,
  EXPLAIN: 20,
  TRANSLATE: 15,
  DOC: 25,
  CODE_READ: 28,
  OPS: 35,
  RESEARCH: 35,
  CODE_EDIT: 42,
  DEBUG: 46,
  BUILD: 50,
  REVIEW: 55,
  REFACTOR: 60,
  ARCHITECTURE: 68,
};

// 分类关键词：[正则, 权重]。同一类累计，取最高分类。
const RULES = [
  ['ARCHITECTURE', /(架构|框架|底层|引擎|技术选型|权衡|系统设计|方案设计|整体设计|模块划分|数据结构设计|如何设计|怎么设计|设计一个|从零设计|长期维护)/g, 6],
  ['REFACTOR', /(重构|优化冗余|冗余代码|清理代码|整理代码|代码质量|抽出来|拆分|解耦|简化实现)/g, 6],
  ['REVIEW', /(审查|评审|复盘|评估一下|帮我看看有没有|有没有问题|边界情况|压力测试|代码审查|安全审计|审计|冲突|不兼容|漏洞)/g, 5],
  ['DEBUG', /(为什么|报错|错误|失败|无法|不能|没反应|不生效|不显示|崩溃|卡住|卡顿|变卡|很卡|卡了|变慢|掉帧|异常|修复|排查|诊断|打不开|运行不了|启动不了|跑不起来|发虚|发糊|错乱|被挡住|少了|不存在|找不到|丢失|不见|不匹配|不一致|对不上)/g, 5],
  ['BUILD', /(写一个|写个|做一个|做个|创建|新建一个|搭建|开发|实现一个|搭一个|生成一个|加上|添加一个|新增|改造|移植|复刻|制作)/g, 5],
  ['CODE_EDIT', /(修改|改成|改一下|改为|替换|调整|更新|升级|版本号|补上|去掉|删除这段|重命名|加进去|加上去)/g, 4],
  ['CODE_READ', /(读一下|看一下代码|解释这段|这段代码|源码|这个文件|函数是|实现原理)/g, 4],
  ['OPS', /(安装|卸载|下载|上传|发布|部署|注册表|权限|启动项|开机|自启|环境变量|npm|pnpm|git|github|命令行|指令|配置|目录|文件夹|磁盘|C盘|D盘|E盘|F盘|清理|残留|服务|计划任务)/g, 4],
  ['FACT', /(是什么|什么意思|是什么意思|有什么用|有啥用|干嘛的|是干嘛|多少|在哪儿|在哪里|在哪个|装在哪|存在哪|谁)/g, 3],
  ['RESEARCH', /(推荐|有哪些|有什么|对比|比较|调研|思路|构想|建议|如何让|怎么才能|规划|可行|方案|生态|市场|如何提高|怎么提高|如何才|怎样才|去网上|上网查|搜索|如何测试|怎么测试)/g, 3],
  ['DOC', /(整理|总结|写成|文档|报告|说明|清单|步骤|列一下|列出来|表格|ppt|演示|提纲)/g, 3],
  ['EXPLAIN', /(如何|怎么|为什么|是什么原理|解释|讲讲|说说|介绍一下|区别)/g, 2],
  ['TRANSLATE', /(翻译|改错别字|润色|改写|变成英文|变成中文)/g, 4],
];

const ACK_RE = /^(好|好的|嗯|哦|ok|OK|行|可以|没问题|加好了|改好了|弄好了|完成了|都完成了|发布完了|合并完了|现在都发布好了|没找到|登不上|是的|对|收到)$/;
const SIMPLE_RE = /(只需要回答|只要回答|只回答|一句话|简单说|大概说|是否可行|可不可以|能不能|有没有风险|有什么风险|是什么|什么意思|干嘛的)/;
const SCOPE_RE = /(所有|全部|整个|全面|系统性地|整体|每一个|逐一|全量|一次全)/;
const MULTI_RE = /(然后|接着|再|最后|第一步|第二步|首先|之后|顺便|同时|并且|以及)/;
const CONSTRAINT_RE = /(确保|必须|一定要|兼容|稳定|安全|不能|不要|避免|边界|测试|验证|回归|不影响|完整性)/;

// 开放/主观题：在征求意见、讨论方案，不是查一个事实。这类回答通常要展开，
// 不能按"一句话问答"降档。
const OPEN_RE = /(你觉得|你认为|你的想法|你的看法|你的意见|想法|看法|思路|建议|构想|怎么看|应该如何|怎样才|如何才|可行)/;
// 祈使/操作动词：出现才说明用户要"动手做"，否则多为提问。
const IMPER_RE = /(帮我|给我|把|麻烦|请你|请帮|检查|修复|删除|卸载|安装|下载|上传|发布|部署|整理|总结|写一|做一个|改一下|改成|优化|测试|扫描|清理|查一下|列出|生成|创建|更新|升级|完成|看看|看一下|分析|评估|对比|排查|诊断|推荐|设计|规划|给出|说明)/;
// 疑问标记
const ASK_RE = /[?？]|吗|呢|是不是|有没有|如何|怎么|为什么|是什么|哪里|哪些|多少|能不能|可不可以|是否/;

// 方法题：问"怎么做到某抽象目标"，要展开讲方法，不是一句话能答的。
// 只收"多步/抽象"动词（提高/测试/设计/实现/优化/推广…），
// 故意不收"查看/设置/发布"这类单步操作——它们问出来也是 T1。
const METHOD_RE = /(如何提高|怎么提高|如何测试|怎么测试|如何设计|怎么设计|如何实现|怎么实现|如何让|怎么让|如何才|怎样才|如何做|怎么做|如何制作|怎么制作|如何优化|怎么优化|如何推广|怎么推广|如何提升|怎么提升|如何解决|怎么解决|怎么做成|如何把|怎么把)/;

const PATH_RE = /([A-Za-z]:\\|\.(js|ts|mjs|cjs|json|md|txt|py|ps1|cmd|bat|yml|yaml|css|html)\b|[\w.-]+\/[\w.-]+)/;
const URL_RE = /https?:\/\//;
const FENCE_RE = /```/g;

function hits(re, text) {
  const m = text.match(re);
  return m ? m.length : 0;
}

function cjkLen(text) {
  let n = 0;
  for (const ch of text) if (ch.charCodeAt(0) > 0x2e80) n++;
  return n;
}

// 分类：取加权命中最高者；全无命中时按句末问号退化为 EXPLAIN/FACT。
export function classify(text) {
  const t = String(text || '').toLowerCase();
  let best = { name: 'FACT', score: 0 };
  for (const [name, re, weight] of RULES) {
    const n = hits(re, t);
    if (!n) continue;
    // 命中次数收益递减，避免长文中堆词就压过其他类
    const s = weight * (n > 3 ? 3 + Math.log2(n - 2) : n);
    if (s > best.score) best = { name, score: s };
  }
  if (best.score === 0) {
    // 没命中任何类型词时按句式兜底：有"把/帮我"这类处置句，多半是改动；
    // 纯问句按解释；其余当一般输出类任务。
    if (/(把|帮我|给我|请|麻烦|改|换|挪|移|删|加)/.test(t)) best = { name: 'CODE_EDIT', score: 2 };
    else if (/[?？]|吗|呢/.test(t)) best = { name: 'EXPLAIN', score: 2 };
    else best = { name: 'DOC', score: 2 };
  }
  return best;
}

// 主入口：score(text, ctx) -> { tier, model, effort, score, category, confidence, signals }
// ctx: { turn, failures, prevTier } —— 全部可选，缺失即按纯文本判断。
export function score(text, ctx = {}) {
  const raw = String(text || '');
  const t = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  const len = raw.length;
  const cn = cjkLen(raw);
  const signals = [];

  // 1) 寒暄 / 确认类短句
  if (ACK_RE.test(t.replace(/[。！!.?？]/g, '')) || (len <= 6 && !/[?？]/.test(t))) {
    return finish('ACK', BASE.ACK - 8, signals.concat('短确认'), ctx, 1);
  }

  // 2) 极短处置句："帮我关X""把X删了"这类一句话操作，当轻任务。
  // 排除真正的重活动词（写/做/开发/设计/优化/分析/排查/整理/生成/部署/测试…）。
  if (len <= 20 && !/[?？]/.test(t)
      && /(帮我|把|请|麻烦|给我|改在|移到|挪到|换到|装到|放到|搬到|删了|删掉|去掉|改到|放到|挪到)/.test(t)
      && !/(写|做|创建|开发|设计|优化|分析|排查|诊断|整理|生成|实现|搭建|重构|发布|部署|测试|修复|升级|扫描|清理|对比|评估|规划|推荐|注册表|残留|卸载)/.test(t)) {
    return finish('OPS', 22, signals.concat('极短处置'), ctx, 0);
  }

  // 2b) 位置/路径陈述："安装路径在D盘的dsh下面""文件在哪个目录" —— 这是查位置的事实陈述，
  // 不是要动手安装/发布，不能因为命中"安装/目录/磁盘"就抬到 OPS。
  // 只认"路径/目录/文件"紧邻"在/位于"且宾语是明确位置词的短陈述。
  if (/(路径|目录|文件夹|文件).{0,6}(在|位于).{0,6}(下面|上面|里面|外边|d盘|c盘|e盘|f盘|哪个目录|哪里|什么地方|哪儿)/.test(raw)
      && !/(帮我|把|请|麻烦|给我|移动|迁移|复制|删除|上传|下载|安装到|放到|挪到|改到|换到)/.test(raw)) {
    return finish('FACT', BASE.FACT, signals.concat('位置陈述'), ctx, 0);
  }

  // 3) 状态确认/完成汇报："已经注册完成""现在是不是上传成功了"。
  // 这些是"告知结果"，不是"要干活"，按轻任务处理；一旦带追问/后续动作就放行。
  if (/^(已经|现在|目前|都|全部)/.test(raw)
      && /(完成|好了|完了|成功|注册|上传|发布|合并|提交|关闭|删除|清理|解决|行了|可以了)/.test(raw)
      && !/(怎么|如何|为什么|帮我|把|请|麻烦|再|然后|接着|下一步|怎么办)/.test(raw)) {
    return finish('ACK', 18, signals.concat('状态确认'), ctx, 0);
  }

  // 4) 任务类型
  let cls = classify(raw);
  const open = OPEN_RE.test(raw);
  if (open && cls.name !== 'DEBUG' && cls.name !== 'ARCHITECTURE') {
    cls = { name: 'RESEARCH', score: 0 };
    signals.push('开放讨论');
  }
  // 开放 + "如何制作/设计/实现 某系统" 本质是架构设计题，不是泛泛讨论。
  // 只认"有具体对象"的开放设计问句，避免把"如何提高命中率"这类方法题误抬。
  if (open && /(如何|怎么|怎样).{0,4}(制作|设计|实现|搭建|构建|开发|架构)/.test(raw)
      && /(插件|软件|系统|游戏|应用|工具|框架|平台|网站|服务|模块)/.test(raw)) {
    cls = { name: 'ARCHITECTURE', score: 0 };
    signals.push('架构设计题');
  }
  // 方法题：问"怎么提高/怎么做/如何设计"，即便被 classify 成 FACT/EXPLAIN 也应是 RESEARCH 档
  if (METHOD_RE.test(raw) && ['FACT', 'EXPLAIN', 'DOC', 'TRANSLATE', 'ACK'].includes(cls.name)) {
    cls = { name: 'RESEARCH', score: 0 };
    signals.push('方法题');
  }
  // 可行性/风险评估咨询："可不可以做""有没有风险""是否可行" —— 要展开讲边界与风险，
  // 不是一句"能做/不能做"能答的，更不该被询问句降档压成 FACT。
  const riskConsult = /(可不可以做|能不能做|是否可行|可行吗|有没有风险|有什么风险|安全风险|风险吗|风险大|封号|违规)/.test(raw);
  if (riskConsult) {
    cls = { name: 'RESEARCH', score: 0 };
    signals.push('风险咨询');
  }
  // 推荐查询："给我推荐几个优质插件" —— 是查询不是动手，轻任务；但要求对比分析的是调研，不降。
  const recommendQ = /(给我|帮我|请你|麻烦).{0,4}(推荐|介绍|找|挑).{0,4}(几个|一些|一个|有哪些|什么)/.test(raw)
      && !/(对比|分析|评估|优缺点|调研|测评)/.test(raw);
  if (recommendQ) {
    cls = { name: 'FACT', score: 0 };
    signals.push('推荐查询');
  }
  // 查看意图："我看看有没有可以改的地方" —— 是查看不是修改；带"然后/接着"后续动作或强改动词的除外。
  // "帮我看看"是祈使要动手（如"帮我看看有没有残留"），不是纯查看，不降。
  const peekIntent = /(我看看|先看看|看看|看一下).{0,4}(有没有|能不能|哪里|哪些)/.test(raw)
      && !/(帮我|给我|请你|麻烦|然后|接着|顺便|并且|之后)/.test(raw)
      && !/(删掉|删除|替换|重构|改一下|改成|优化|升级|补上|加上|改到)/.test(raw)
      && len < 40;
  if (peekIntent) {
    cls = { name: 'CODE_READ', score: 0 };
    signals.push('查看意图');
  }
  // 重任务识别：必须先于"询问句降档"判断。这些句子自带"要展开做"的信号，
  // 不该被降档成 FACT 后再用错误的基准分去加分。
  // （历史 bug：生态调研 +20 曾加在 FACT 12 上，r037 只判到 RESEARCH 32。）
  const ecoResearch = /(结合|基于|参考).{0,16}(已有|现有|网络|市场|生态)/.test(raw)
      && (/(升级|更新|优化|改进|提升|方向)/.test(raw)
          || /(有没有类似|有哪些类似|有没有同类|有没有竞品|竞品|同类)/.test(raw));
  const replica = /(复刻|模仿|重做|仿制).{0,8}(游戏|软件|系统|应用|网站|工具|插件|程序)/.test(raw);
  const hasAttachment = /@[A-Za-z]:[\\/]/.test(raw);
  // 数据工程/评测调优："训练/评测/调参/数据集/标注/召回率"是数据工作，不是改代码。
  // 尤其要纠正 classify 兜底把"把…拉过来训练"当成 CODE_EDIT 的误判。
  // 注意：不收孤立的"准确率/基准测试"——那可能只是产品指标（如"推荐准确率≥60%"），
  // 不是真的要跑训练/评测流水线。
  const dataWork = /(训练|调参|数据集|标注|召回率|混淆矩阵|benchmark)/.test(raw);
  if (ecoResearch) { cls = { name: 'RESEARCH', score: 0 }; }
  if (replica) { cls = { name: 'BUILD', score: 0 }; }
  if (dataWork && ['CODE_EDIT', 'DEBUG', 'BUILD'].includes(cls.name)) { cls = { name: 'RESEARCH', score: 0 }; signals.push('数据工程'); }
  // 询问句降档：问一个点、确认一个状态时，安装/发布/npm 这些词只是话题，不是要动手。
  // 保留四类问句：深度追问（为什么）、方法题、检查/扫描类操作、联网调研。
  const question = /[?？]|吗|呢|吧|是不是|是否|有没有|能不能|可不可以|怎么|如何|多少|哪里|在哪|是什么|什么意思|为什么|为何/.test(raw);
  const deepWhy = /为什么|为何/.test(raw);
  const methodQ = METHOD_RE.test(raw);
  const hasImper = /(帮我|请你|请帮|麻烦|给我)/.test(raw);
  const inspectOp = /(检查|扫描|清理|排查|诊断).{0,16}(有没有|是否|是不是|什么|哪里|哪|垃圾|残留|冲突|不兼容|问题|可删|删除)/.test(raw);
  const webResearch = /(去网上|上网查|上网搜|搜索|找一下|查一下|查询|测评|调研)/.test(raw);
  const multiStep = /(然后|接着|之后|后续|下一步)/.test(raw);
  const mayDo = /(可以|能|能不能|可不可以).{0,20}(移动|迁移|上传|下载|删除|卸载|修改|调整|清理|复制|传到|发布)/.test(raw);
  if (question && !deepWhy && !methodQ && !open && !hasImper && !inspectOp && !webResearch && !multiStep && !mayDo && !ecoResearch && !replica && !hasAttachment && !riskConsult && !recommendQ) {
    if (['OPS', 'BUILD', 'CODE_EDIT', 'CODE_READ', 'REVIEW', 'DOC', 'RESEARCH'].includes(cls.name)) {
      cls = { name: 'FACT', score: 0 };
      signals.push('询问句');
    }
  }
  let s = BASE[cls.name];
  signals.push(cls.name);

  // 3) 规模修饰
  if (len > 1600) { s += 12; signals.push('长文 +12'); }
  else if (len > 600) { s += 9; signals.push('较长 +9'); }
  else if (len > 200) { s += 5; signals.push('中等长度 +5'); }

  const fences = hits(FENCE_RE, raw);
  if (fences >= 4) { s += 8; signals.push('多段代码 +8'); }
  else if (fences >= 2) { s += 5; signals.push('含代码 +5'); }

  if (PATH_RE.test(raw)) { s += 3; signals.push('含路径/文件名 +3'); }
  if (URL_RE.test(raw)) { s += 2; signals.push('含链接 +2'); }

  // 产出物识别：明确要"产出文档/设计图"的任务，比一般"说说/解释"重一档。
  // 只认"动词 + 产出物名词"的组合，避免误伤"帮我看看文档"这类查看。
  if (/(整理|总结|归纳|汇总|提炼|写出|编写|撰写).{0,20}(说明|文档|手册|指南|教程|清单|列表|表格|报告|笔记|方案)/.test(raw)) {
    s += 8; signals.push('文档产出 +8');
  }
  if (/(模块图|架构图|流程图|结构图|时序图|类图|设计图|原型图|示意图|思维导图|ER图)/.test(raw)) {
    s += 8; signals.push('设计图产出 +8');
  }
  if (SCOPE_RE.test(raw)) { s += 6; signals.push('大范围 +6'); }
  if (MULTI_RE.test(raw) && len > 40) { s += 4; signals.push('多步骤 +4'); }

  const constraints = hits(CONSTRAINT_RE, raw);
  if (constraints >= 2) { s += 7; signals.push('多重硬约束 +7'); }
  else if (constraints === 1) { s += 4; signals.push('带约束 +4'); }

  // "为什么"出现在长句里，通常意味着未知原因排查，而不是一句概念解释
  if (/为什么/.test(raw) && len > 40) { s += 4; signals.push('追问原因 +4'); }

  // 诊断+修复双动作：明确"检查/排查原因"且要"修复/解决"，比单纯报错上一档
  if (cls.name === 'DEBUG'
      && /(检查|排查|诊断).{0,6}(原因|哪里|哪|问题|为什么)/.test(raw)
      && /(修复|解决|处理|改|调整|优化)/.test(raw)) {
    s += 10; signals.push('诊断+修复 +10');
  }

  // 改动后回归排查：改了某设置/某处之后反而出问题（变卡/报错/没反应），是因果链排查，比单纯报错重。
  if (cls.name === 'DEBUG'
      && /(改了|修改|调整|更新|升级|更换|换了|装了|安装了|卸载了|设置了|关闭了|打开了|删了).{0,12}(之后|以后|后).{0,12}(变卡|卡了|卡顿|变慢|慢了|崩溃|崩了|报错|错误|没反应|不生效|不显示|反而)/.test(raw)) {
    s += 10; signals.push('改动回归排查 +10');
  }

  // 竞品/生态调研：结合已有现状，要求给出升级方向并说明有无同类 → 深度调研，非一句话咨询。
  // 这类问题回答要展开，不能按"问个点"降档，更不该落到 FACT。
  if (ecoResearch) {
    cls = { name: 'RESEARCH', score: 0 };
    s += 22; signals.push('生态调研 +22');
  }

  // 复刻/模仿一款游戏或应用 = 大创作任务，不是"写个小脚本"。
  if (/(复刻|模仿|重做|仿制).{0,8}(游戏|软件|系统|应用|网站|工具|插件|程序)/.test(raw)) {
    cls = { name: 'BUILD', score: 0 };
    s += 8; signals.push('复刻大创作 +8');
  }

  // 引用 @附件（@盘符路径）通常意味着"基于这个文件做任务"，比一般描述重。
  if (/@[A-Za-z]:[\\/]/.test(raw)) {
    s += 10; signals.push('引用附件 +10');
    // 附件 + 创作性修改（大改/重新/重做/改写），是跨文件创作，不是"看看/翻译"。
    if (/(大改|重新|重做|改写|修改|调整|生成|制作|创建|重新设计|重新排版)/.test(raw)) {
      s += 6; signals.push('基于附件创作 +6');
    }
  }

  // 方案设计：结合上下文/记忆/现状，要求给出优化或推荐方案（"在已有基础上结合上下文和记忆"）。
  // 这是要展开设计的深度任务，不是一句"怎么提高"的方法题。
  if (/(结合|基于|根据).{0,12}(上下文|记忆|现状|已有|当前).{0,16}(优化|推荐|建议|改进|提升|设计|调整)/.test(raw)) {
    s += 10; signals.push('方案设计 +10');
  }

  // 4) 明确的"轻量"自述（对实打实的创建/改造类任务不降分：活还是要干）
  const heavy = ['BUILD', 'CODE_EDIT', 'REFACTOR', 'ARCHITECTURE', 'OPS'].includes(cls.name);
  if (!heavy && !open && !METHOD_RE.test(raw) && len < 60 && SIMPLE_RE.test(raw)) { s -= 8; signals.push('要求简短 -8'); }
  if (len <= 14 && !open && !METHOD_RE.test(raw)
      && !/(完成|发布|步骤|生成|制作|画出|写出|画一|做一|安装|部署|配置|修复|排查)/.test(raw)) { s -= 6; signals.push('极短 -6'); }

  // 5) 对话上下文：连着问很多轮或前面刚失败过，难度上调
  const turn = Number(ctx.turn) || 0;
  if (turn >= 6) { s += 4; signals.push('第' + turn + '轮上下文 +4'); }
  else if (turn >= 3) { s += 2; signals.push('多轮上下文 +2'); }
  if (Number(ctx.failures) >= 2) { s += 5; signals.push('此前多次未解决 +5'); }

  // 6) 上下文规模：这不是"这句话难不难"，而是"现在这个对话已经多重"。
  // 实测会话里约 98% 的输入是系统注入（记忆、压缩摘要、运行时上下文），
  // 每轮的真实成本由它主导，而不是由用户刚打的那几十个字决定。
  const contextTokens = Math.max(0, Number(ctx.contextTokens) || 0);
  if (contextTokens >= 96000) { s += 5; signals.push('超长上下文 +5'); }
  else if (contextTokens >= 32000) { s += 3; signals.push('长上下文 +3'); }
  else if (contextTokens >= 12000) { s += 1; signals.push('中等上下文 +1'); }

  return finish(cls.name, s, signals, ctx, 0);
}

function finish(category, s, signals, ctx, forced) {
  let v = Math.max(0, Math.min(100, Math.round(s)));
  let tier;
  if (forced === 1) tier = 1;
  else if (v < 32) tier = 1;
  else if (v < 56) tier = 2;
  else tier = 3;

  // 档位粘性：上一轮已经是强档，且本轮只是小幅回落，不轻易降档
  const prev = Number(ctx.prevTier) || 0;
  if (!forced && prev === 3 && tier === 2 && v >= 55) {
    tier = 3;
    signals = signals.concat('沿用上一轮强档');
  }

  // 长上下文里的"省档"是假省钱：off 省的是输出，而输入（全量上下文）一分不省；
  // 一旦答错要重来，再读一遍上下文比省下的那点输出贵一个数量级。
  // 所以会话已经又长又深（≥4 轮、≥48K token）时，不再推荐省档。
  const contextTokens = Math.max(0, Number(ctx.contextTokens) || 0);
  const turn = Number(ctx.turn) || 0;
  if (!forced && tier === 1 && contextTokens >= 48000 && turn >= 4) {
    tier = 2;
    signals = signals.concat('长上下文 → 不再用省档');
  }

  const d1 = Math.abs(v - 32);
  const d2 = Math.abs(v - 56);
  const confidence = Math.min(1, Math.max(0, (Math.min(d1, d2) / 20) + 0.35));
  const meta = TIERS[tier];

  // 极难任务：仍在"强"档，但把 effort 从 high 提到 max。
  // 只认少数类型 + 各自的分数门槛，避免把"话多"误判成"难"。
  let effort = meta.effort;
  const need = MAX_THRESHOLD[category];
  if (!forced && tier === 3 && need && v >= need) {
    effort = 'max';
    signals = signals.concat('极难任务 → max');
  }

  return {
    tier,
    key: meta.key,
    model: meta.model,
    effort,
    color: meta.color,
    score: v,
    category,
    confidence: Number(confidence.toFixed(2)),
    contextTokens,
    signals,
  };
}

// 供客户端显示的极简结果：只留模型、推理等级、时段与"上下文是否已经很重"。
// 不暴露分数和理由。
export function present(result, now = Date.now()) {
  const contextTokens = Math.max(0, Number(result.contextTokens) || 0);
  return {
    tier: result.tier,
    key: result.key,
    model: result.model,
    effort: result.effort,
    color: result.color,
    peak: peakOf(now),
    longContext: contextTokens >= 48000,
  };
}
