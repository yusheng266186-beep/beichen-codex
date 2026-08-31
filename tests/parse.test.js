/* 星图解析行为级测试:从 index.html 提取页面真实函数,跑关键场景。
   这些场景覆盖了历史上导致"星图永远显示不出来"的死循环案例。 */
const assert = require('assert');
const fs = require('fs');
const index = fs.readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');

function grab(startMarker) {
  const i = index.indexOf(startMarker);
  assert.ok(i >= 0, 'missing ' + startMarker);
  const j = index.indexOf('\n}', i);
  return index.slice(i, j + 2);
}
const lib = [
  /const COMBOS = \[[\s\S]*?\];/.exec(index)[0],
  /const REPORT_LABELS = \[[\s\S]*?\];/.exec(index)[0],
  grab('function cleanText'),
  grab('function cleanTitle'),
  grab('function normCombo'),
  grab('function parseReport')
].join('\n\n');
(0, eval)(lib);

function cardLine(t, b) { return '\n【星卡】' + t + '||' + b; }
function buildReport(opts) {
  const o = Object.assign({abbr: false, newlineCombo: false, noMajor: false, noBless: false, fourCards: false, noStarValue: false}, opts || {});
  let out = '\n【北辰星图】\n【称号】拆齿轮的观星人';
  if (!o.noStarValue) out += '\n【星值】62';
  out += '\n【方位】理科';
  out += '\n【一句话】动手的直觉是你的底色，把粗心驯服，理科的路会越走越亮。';
  const cards = [
    ['学科底色', '你提到物理课总提前做完，这种手感是真实的礼物。'],
    ['思维与学习', '推导让你投入，材料的慢读则需要一点耐心。'],
    ['热爱与方向', '拆装机械的夜晚，说明你适合动手创造的世界。'],
    ['决策透视', '黄金三角里，前景一角还需补齐。'],
    ['盲区叮嘱', '别让一次考试的粗心，盖住你真正的天赋。']
  ];
  (o.fourCards ? cards.slice(0, 4) : cards).forEach(c => { out += cardLine(c[0], c[1]); });
  const combo = o.abbr ? '物化生' : '物理+化学+生物';
  const alt = o.abbr ? '物化地' : '物理+化学+地理';
  out += o.newlineCombo
    ? '\n【组合】' + combo + '\n首选理由：动手与原理兼顾\n' + alt + '\n备选理由：保留地理的赋分空间'
    : '\n【组合】' + combo + '||理由：动手与原理兼顾||' + alt + '||理由：保留地理的赋分空间';
  if (!o.noMajor) out += o.majorsTriple
    ? '\n【专业】机械工程||与拆装机械的热爱直接对口，动手与原理两头都占，物理+化学满足工科门槛||智能制造、机器人与装备研发，深造后路径更宽||车辆工程||动手直觉的延伸方向，首选组合完全覆盖||整车研发、零部件设计与测试，行业路径成熟||自动化||推理舒适区的落点，就业面宽||工业控制、嵌入式与机器人算法，制造业数字化刚需'
    : o.majorsPaired
    ? '\n【专业】机械工程||与拆装机械的热爱直接对口，物理+化学满足工科门槛||车辆工程||动手直觉的延伸方向，首选组合完全覆盖||自动化||推理舒适区的落点，就业面宽'
    : '\n【专业】机械工程、车辆工程、自动化';
  if (!o.noBless) out += '\n【寄语】愿你带着拆齿轮的好奇心，把每一道难题都拆成自己能懂的样子。';
  return out;
}
function check(tag, text, expect) {
  const r = parseReport(text);
  let pass;
  if (expect === null) pass = r === null;
  else if (expect === 'loose') pass = r !== null && r._complete === false;
  else pass = r !== null && r._complete === true;
  assert.ok(pass, tag + ' → ' + (r ? '_complete=' + r._complete : 'null'));
  console.log('  ok', tag);
}
check('标准全字段 → 严格档渲染', buildReport(), true);
check('组合口语缩写 物化生/物化地(历史死因) → 严格档渲染', buildReport({abbr: true}), true);
check('组合换行分隔 → 渲染', buildReport({newlineCombo: true}), true);
check('缺专业/寄语且仅4卡 → 宽容档渲染不卡死', buildReport({noMajor: true, noBless: true, fourCards: true}), 'loose');
check('缺星值 → 宽容档渲染(方位回退)', buildReport({noStarValue: true}), 'loose');
check('无关文本 → null(走一次修复)', '完全无关的闲聊内容。', null);

/* v2.6.7 专业三段格式(名||分析||就业方向)为主;两段组与旧顿号名单逐级宽容降级 */
const rt = parseReport(buildReport({majorsTriple: true}));
assert.ok(rt && rt._complete, '三段专业格式 → 严格档解析');
assert.ok(Array.isArray(rt._majors) && rt._majors.length >= 3 && rt._majors.every(m=>m.name && m.reason && m.career), '三段格式 → 分析+就业方向齐全');
const rp = parseReport(buildReport({majorsPaired: true}));
assert.ok(rp && rp._complete, '两段专业格式 → 严格档解析');
assert.ok(Array.isArray(rp._majors) && rp._majors.length >= 3 && rp._majors.every(m=>m.name && m.reason && !m.career), '两段格式 → 降级为仅分析');
const rl = parseReport(buildReport());
assert.ok(Array.isArray(rl._majors) && rl._majors.length >= 3 && rl._majors.every(m=>m.name && !m.reason && !m.career), '旧顿号格式 → 降级为纯名字');
console.log('parse tests passed');
