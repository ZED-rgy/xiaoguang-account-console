const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadCharts(fillTexts) {
  const context = {
    window: { devicePixelRatio: 1 },
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {} }),
      body: { appendChild: () => {} },
    },
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'frontend', 'charts.js'), 'utf8'),
    context,
  );

  const ctx = {
    setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    fill() {}, fillRect() {}, arcTo() {}, closePath() {},
    measureText(text) { return { width: String(text).length * 7 }; },
    fillText(text, x, y) { fillTexts.push({ text: String(text), x, y }); },
  };
  const canvas = {
    width: 800,
    height: 240,
    getBoundingClientRect: () => ({ width: 800, height: 240 }),
    getContext: () => ctx,
  };
  return { Charts: context.window.Charts, canvas };
}

test('账号堆叠图将账号名和平台分两行完整绘制', () => {
  const texts = [];
  const { Charts, canvas } = loadCharts(texts);

  Charts.stackedBar(canvas, {
    labels: ['内容 · 实验室 · 小红书'],
    series: [{ name: '点赞', data: [0], color: '#0f766e' }],
  });

  const accountLabel = texts.find(item => item.text === '内容 · 实验…');
  const platformLabel = texts.find(item => item.text === '小红书');
  assert.ok(accountLabel);
  assert.ok(platformLabel);
  assert.equal(accountLabel.x, platformLabel.x);
  assert.ok(accountLabel.y < platformLabel.y);
});
