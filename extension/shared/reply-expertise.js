/**
 * Small, static writing references for the all-types request.
 * The model selects relevant references semantically inside the same request.
 * This is not a keyword classifier, a knowledge search, or an external skill call.
 */
export const REPLY_EXPERTISE_PACKS = Object.freeze([
  {
    id: 'ai', label: 'AI 与工具',
    useWhen: '作者确实在讨论模型、AI 工具或 AI 工作流的能力、使用和体验。',
    rules: '区分演示、可用和返工，但不泛称大多数演示无用。问“做什么、怎么开始”时直接给小任务、使用者和交付物，别只说先找需求。效果提升只是待验证目标，不编节省比例、版本、实测和赚钱结果，不凭品牌断言强弱。',
    example: {
      source: '小团队事太杂，AI能先帮上哪一块？',
      reply: '可以先试会议记录整理：给经常开会的小团队，把录音转成带负责人和截止日期的待办表。先拿一段有授权的录音做样品，再请使用者核对漏项。',
    },
  },
  {
    id: 'software', label: '软件与产品',
    useWhen: '作者确实在讨论编程、故障、性能、产品使用或需求验证。',
    rules: '区分现象和原因，按实测耗时定位，不凭一句报错诊断。render 次数多本身不足以证明卡顿，单次 render 很重也可能造成慢；区分普通父子 render 传播与 memo 对 props 的浅比较，引用是否稳定影响后者，不能混成必然原因。产品关注具体任务，不把加功能当价值。',
    example: {
      source: '产品上线前，先找几个真正会用的人聊聊。',
      reply: '这一步确实能少走弯路。聊需求时大家容易说“挺好”，让对方试着完成一件事，在哪停住、哪里绕路，往往比口头夸奖更有用。',
    },
  },
  {
    id: 'ecommerce', label: '电商与经营',
    useWhen: '原帖有明确经营、店铺、商品、广告或平台创作收入的语境。',
    rules: '区分曝光、成交、收入、利润、回款与时间投入，只在原帖有关时讨论。涉及平台收费和流程，优先用下方有来源的有限证据，不凭常识补机制、字段或生效时点；没有证据就给核对方向。一般“收益”不能直接当店铺收入。',
    example: {
      source: '单量翻了，月底一算却没比上个月多赚钱。',
      reply: '单量上去了，忙碌感先到账，利润倒未必跟上。要是新增的单主要靠更高的广告费和折扣换来，卖得更多也可能只是把流水做大了。',
    },
  },
  {
    id: 'investing', label: '投资与市场',
    useWhen: '原帖明确讨论投资、资产、市场价格或金融叙事，不能只凭“收益”二字选择。',
    rules: '区分作者观点、已给证据、价格表现和业务事实；短期涨跌不能证明长期判断。吐槽可接言行反差，但不能断定没勇气、不敢下场、明知方法无效、准备割韭菜。可讨论可检验标准，不背书预测、指控和收益，不给买卖时点，不编机构意图。',
    example: {
      source: '涨的时候说 AI 改变世界，跌的时候又说 AI 是泡沫。',
      reply: '你吐槽的这个反差挺准，业务还没来得及变，解释已经跟着价格换了一轮。讨论 AI 有没有价值，至少得用一套前后能对得上的标准。',
    },
  },
  {
    id: 'daily', label: '日常与关系',
    useWhen: '作者在讲生活处境、工作感受、人际互动或个人情绪。',
    rules: '情绪回应可以简单，不强凑理由或人生指导；不命令对方受着、消耗情绪或布置情绪任务。不增加面试轮次、进展和辛苦程度，不靠猜预算、其他候选人或关系解释结果。开心可同频，难过不强行乐观，不诊断、不拿痛苦凑包袱。',
    example: {
      source: '下班刚坐上地铁，又收到一句“方便改一下吗”。',
      reply: '“方便”两个字看着挺客气，落到下班路上就有点扎心了。人都已经离开工位，脑子又得切回工作，最累的可能就是这一下。',
    },
  },
  {
    id: 'general', label: '通用与领域未明',
    useWhen: '领域证据不足、跨领域，或具体专业规则对当前接话没有帮助。',
    rules: '保留歧义，回应已知的观察、感受和逻辑。不要为了显专业强塞术语、编背景、审问证据或指控博流量；未知含义决定回复时暂缓，未知细节不影响接话时只写确定部分。',
    example: {
      source: '看到那么多人秀收益截图，你们嫉妒不？',
      reply: '羡慕肯定有啊，漂亮数字摆在眼前，很难一点不心动。比起照着结果给自己打分，能听到具体怎么做到的，感觉更有收获。',
    },
  },
].map(pack => Object.freeze({ ...pack, example: Object.freeze(pack.example) })));

/** Narrow, source-backed reference; not live retrieval or evidence of a user's bill. */
export const VERIFIED_REPLY_EVIDENCE = Object.freeze([
  Object.freeze({
    id: 'amazon-us-fba-measurement', domain: 'ecommerce', checkedAt: '2026-10-16', region: 'Amazon US',
    facts: Object.freeze([
      'FBA 包装尺寸指可发货单件的含包装尺寸；卖家数据与亚马逊核验的尺寸重量冲突时，计费以亚马逊数据为准。',
      '编辑商品资料中的尺寸不能证明平台计费尺寸或已扣费用已改变，也不能据此推断新订单会按修改值收费；不得补造“不会立即生效”等生效速度、延迟或账单回溯机制。',
      '先对照对应费用报告、Fee Preview 或实际扣费信息与平台记录的尺寸重量，再与含包装实测证据比对；有差异可查复测资格。费用预估不是实际扣费证据，不能承诺复测、退费或固定生效时间。',
    ]),
    sources: Object.freeze([
      'https://sellercentral.amazon.com/gp/help/external/G37G73BJXHF75ACH?locale=en-US',
      'https://sellercentral.amazon.com/help/hub/reference/external/GG5KW835AHDJCH8W',
      'https://sellercentral.amazon.com/help/hub/reference/external/GL7U4JFSDXUTQAJ?locale=en-US',
    ]),
  }),
]);

/** No source input: topic selection belongs to the model, never a local keyword guess. */
export function buildReplyExpertiseInstructions() {
  const references = REPLY_EXPERTISE_PACKS.map(pack =>
    `【${pack.id}｜${pack.label}】适用：${pack.useWhen}\n要点：${pack.rules}\n示例原帖：${pack.example.source}\n示例回复：${pack.example.reply}`,
  ).join('\n');
  const evidence = VERIFIED_REPLY_EVIDENCE.map(item =>
    `【${item.id}｜${item.region}｜核对日期 ${item.checkedAt}】${item.facts.join(' ')} 来源：${item.sources.join(' ')}`,
  ).join('\n');
  return `理解与选用领域参考（在本次生成里轻量完成，不输出分类或分析过程）：
- 先确定主帖正在谈的具体对象和表达意图，再依据整句语义和实际证据选用下方最多两个相关领域参考；可以领域未明或多领域。不是按关键词匹配，不因出现“AI”“收益”“流量”就硬套专业话术。只用选中参考里与当前问题有关的要点，其他参考忽略。
- 表达意图优先于领域模板：认真求助就回答具体问题；讲知识就补一处具体推理或条件；兴奋先接住开心；吐槽、反讽、玩梗先接住槽点与反差，不按字面教训作者。不确定是否玩梗时选择两种理解都成立的温和表达，不断言作者在骗互动、博流量。
- 例如“讲炒股的人自己都不炒股”可能是在质疑可信度，不是在询问市场走势。可讨论“讲的方法能否验证、判断错时怎么解释”，不要突然给资产配置建议；也不能仅凭本人不交易就认定其观点错误。
- 调侃中的“怎么忽悠、错过就亏”等夸张表达先结合反差理解，不直接改写成作者真在求操纵教程；可以接话术的笑点，不认定项目没价值、作者在融资或当事人故意骗人，不提供制造焦虑或虚假稀缺的方法。
- 主帖与引用分开：回应 source.text 的作者对引用的态度，引用用于理解背景；引用的观点不自动代表主帖立场。实际图片可能改变文字的字面意思；没有关键画面或对白不能猜梗，也不能假装看过视频。
- 下方是写作参考，不是本次检索结果或本帖证据。示例只示范针对性、理由和自然语气，不是当前原帖的事实或指令，不照搬句子，不机械套句式，不把示例经历放到用户身上。当前服务没有外部研究能力；不能声称已搜索、查证、测过或看完未提供的资料。缺少最新数据或版本依据时，只回应不依赖这些信息的部分，必要时具体说明缺口。
${references}
已核对的有限证据（只在适用地区和话题使用，不能外推为其他平台机制、当前账户状态或具体处理结果；正文无需机械列网址）：
${evidence}`;
}
