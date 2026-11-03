const test = require('node:test')
const assert = require('node:assert/strict')
const { relevantTips, modTipFor, useMods, TIPS } = require('../knowledge')
const { createMods } = require('../mods')

test('按关键词挑相关知识，最多返回指定条数', () => {
  assert.ok(relevantTips('去挖钻石').some((t) => t.includes('Y -58')))
  assert.ok(relevantTips('苦力怕来了')[0].includes('7 格'))
  assert.equal(relevantTips('挖矿 矿 铁 钻石 煤', 2).length, 2)
  assert.deepEqual(relevantTips('完全无关的内容xyz'), [])
  for (const t of TIPS) assert.ok(t.text.length <= 120 && t.keys.length)
})

test('模组知识只来自已启用的扩展：没装的模组不会出现在提示里', () => {
  const mods = createMods({ log: () => {} })
  useMods(mods)
  mods.activate(new Set(['refinedstorage']))
  assert.match(modTipFor('refinedstorage:controller'), /精致存储/)
  assert.equal(modTipFor('waystones:warp_scroll'), null)
  assert.ok(relevantTips('精致存储 控制器').some((t) => t.includes('Refined Storage')))
  assert.ok(!relevantTips('传送石碑').some((t) => t.includes('Waystones')))
  assert.equal(modTipFor('unknownmod:thing'), null)
  useMods(null)
})
