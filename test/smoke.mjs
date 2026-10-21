const s = await import('file:///C:/Users/minut/OneDrive/%E6%96%87%E6%A1%A3/deepseek-harness/default-workspace/work/dsh-tier-brain/lib/scoring.js');
const samples = [
  '你好',
  '缓存命中是什么意思，如何提高这个命中率',
  '帮我把这个界面的卡片位置挪到输入框下方，别挡住按钮',
  '我改了之后游戏变卡了，查一下原因',
  '我想做一个插件，判断用户的问题难度，思路是什么',
  '重构这个模块的评分逻辑，拆成纯函数，并补上测试',
  '把电脑上那个未知的未签名系统服务删掉，注意别弄坏系统',
];
for (const t of samples) {
  const r = s.score(t);
  console.log(JSON.stringify(s.present(r)), '<-', r.category, r.score, '|', t.slice(0, 24));
}