// Shared public metadata for ESM callers and isolated-world content scripts.
// Legacy candidate `style` IDs remain stable slots; replyStyle is the actual choice.
(()=>{
  const entries=[
    {id:'chat',label:'日常聊天',description:'自然随和，顺着具体内容接话',instruction:'像日常聊天一样自然随和，回应具体内容，不套总结句。'},
    {id:'playful',label:'轻松有梗',description:'顺着反差接梗，适度幽默',instruction:'表达轻松有趣，顺着原帖语境适度接梗；严肃、悲伤或求助时克制，不强凑笑话。'},
    {id:'professional',label:'理性专业',description:'补充依据、条件或具体观察',instruction:'观点清楚，理由具体；补充相关条件、依据或观察，需要事实依据时守住不确定性，不堆术语。'},
    {id:'sharp',label:'犀利克制',description:'指出矛盾，有锋芒不攻击人',instruction:'点出关键矛盾，有锋芒但不攻击个人，不为抬杠而反对。'},
    {id:'agree',label:'认可共鸣',description:'认同具体一点，再往前说一步',instruction:'认可原帖一处具体的观察、感受或做法，再说有依据的原因或影响；不盲目背书未知指控、预测或收益。'},
    {id:'perspective',label:'换个角度',description:'换一个有用的观察或评判标准',instruction:'从另一个相关对象、具体影响、可检验标准或明确假设切入，给出不同内容，不自动反对，不编故事或经历。'},
    {id:'practical',label:'实用建议',description:'回答具体问题，给出可做的一步',instruction:'仅在确有求助或建议语境时给出具体可行的一步和理由；不把反问玩梗当求助，不在缺少关键材料时冒充专业诊断。'},
    {id:'empathetic',label:'温和共情',description:'接住处境和感受，不说教',instruction:'温和回应已表达的处境和感受，不诊断、不猜心理，不布置情绪任务，不强行乐观或讲人生道理。'},
  ];
  const styles=Object.freeze(entries.map(item=>Object.freeze(item)));
  const labels=Object.freeze(Object.fromEntries(styles.map(item=>[item.id,item.label])));
  const legacy=Object.freeze({witty:'agree',humor:'playful',insight:'professional',story:'perspective'});
  Object.defineProperty(globalThis,'XReplyStyleCatalog',{value:Object.freeze({styles,labels,legacy}),configurable:true});
})();
