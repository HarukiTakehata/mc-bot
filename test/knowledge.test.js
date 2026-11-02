const test = require('node:test')
const assert = require('node:assert/strict')
const { relevantTips, modTipFor, TIPS, MOD_TIPS } = require('../knowledge')

test('按关键词挑相关知识，最多返回指定条数', () => {
  assert.ok(relevantTips('去挖钻石').some((t) => t.includes('Y -58')))
  assert.ok(relevantTips('苦力怕来了')[0].includes('7 格'))
  assert.equal(relevantTips('挖矿 矿 铁 钻石 煤', 2).length, 2)
  assert.deepEqual(relevantTips('完全无关的内容xyz'), [])
})

test('模组物品按命名空间找到对应说明；每条知识都足够短', () => {
  assert.match(modTipFor('refinedstorage:controller'), /精致存储/)
  assert.match(modTipFor('waystones:warp_scroll'), /传送/)
  assert.equal(modTipFor('unknownmod:thing'), null)
  for (const t of [...TIPS, ...MOD_TIPS]) assert.ok(t.text.length <= 120 && t.keys.length)
})
