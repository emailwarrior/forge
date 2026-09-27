// Insights (UI-D): the sanitizing markdown renderer used for Ask answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, inline, escapeMd } from '../../js/ui/parts/insights-md.js';

const ALLOWED = new Set(['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'ul', 'ol', 'li', 'h4', 'h5', 'blockquote', 'hr', 'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
function tagsOf(html) { return [...html.matchAll(/<\/?([a-z0-9]+)([^>]*)>/g)].map((m) => ({ tag: m[1], attrs: m[2].trim() })); }
function assertSafe(html) {
  for (const { tag, attrs } of tagsOf(html)) {
    assert.ok(ALLOWED.has(tag), `unexpected tag <${tag}> in ${html}`);
    assert.ok(attrs === '' || attrs === 'class="num"' || attrs === 'class="table-wrap"' || attrs === 'class="data"', `unexpected attributes "${attrs}"`);
  }
}

test('md: escapes raw HTML before anything else', () => {
  const html = renderMarkdown('<script>alert(1)</script> and <img src=x onerror="alert(2)"> **bold**');
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('onerror=&quot;alert(2)&quot;'));
  assert.ok(html.includes('<strong>bold</strong>'));
  assertSafe(html);
});

test('md: escape helper covers quotes and ampersands once', () => {
  assert.equal(escapeMd(`a & b < c > d " e ' f`), 'a &amp; b &lt; c &gt; d &quot; e &#39; f');
  assert.equal(renderMarkdown('Fish & chips'), '<p>Fish &amp; chips</p>');
});

test('md: paragraphs and soft line breaks', () => {
  assert.equal(renderMarkdown('One\ntwo\n\nThree'), '<p>One<br>two</p><p>Three</p>');
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown('\n\n  \n'), '');
});

test('md: bold, italics, strike, inline code', () => {
  assert.equal(inline('**a** and __b__'), '<strong>a</strong> and <strong>b</strong>');
  assert.equal(inline('*x* and _y_'), '<em>x</em> and <em>y</em>');
  assert.equal(inline('**bold *it* bold**'), '<strong>bold <em>it</em> bold</strong>');
  assert.equal(inline('~~gone~~'), '<del>gone</del>');
  assert.equal(inline('use `a*b*c` here'), 'use <code>a*b*c</code> here');
  // Not emphasis: arithmetic, snake_case, lone markers.
  assert.equal(inline('2 * 3 * 4'), '2 * 3 * 4');
  assert.equal(inline('a*b*c'), 'a*b*c');
  assert.equal(inline('snake_case_name'), 'snake_case_name');
  assert.equal(inline('**open'), '**open');
});

test('md: inline code keeps escaped HTML as text', () => {
  const html = renderMarkdown('Run `<b>x</b>` now');
  assert.equal(html, '<p>Run <code>&lt;b&gt;x&lt;/b&gt;</code> now</p>');
});

test('md: links and images keep only their label', () => {
  const html = renderMarkdown('See [the study](javascript:alert(1)) and ![pic](http://x/y.png)');
  assert.equal(html, '<p>See the study and pic</p>');
  assertSafe(html);
});

test('md: unordered, ordered and nested lists', () => {
  assert.equal(renderMarkdown('- one\n- **two**\n* three'), '<ul><li>one</li><li><strong>two</strong></li><li>three</li></ul>');
  assert.equal(renderMarkdown('1. first\n2. second'), '<ol><li>first</li><li>second</li></ol>');
  assert.equal(renderMarkdown('- parent\n  - child a\n  - child b\n- next'), '<ul><li>parent<ul><li>child a</li><li>child b</li></ul></li><li>next</li></ul>');
  assert.equal(renderMarkdown('Intro:\n- a\n- b\n\nAfter'), '<p>Intro:</p><ul><li>a</li><li>b</li></ul><p>After</p>');
  assert.equal(renderMarkdown('1. a\n\n2. b'), '<ol><li>a</li><li>b</li></ol>');
});

test('md: headings, quotes, rules, code blocks', () => {
  assert.equal(renderMarkdown('## Summary'), '<h4>Summary</h4>');
  assert.equal(renderMarkdown('### Detail ###'), '<h5>Detail</h5>');
  assert.equal(renderMarkdown('> quoted\n> more'), '<blockquote>quoted<br>more</blockquote>');
  assert.equal(renderMarkdown('a\n\n---\n\nb'), '<p>a</p><hr><p>b</p>');
  assert.equal(renderMarkdown('```js\nconst x = 1 < 2;\n**not bold**\n```'), '<pre><code>const x = 1 &lt; 2;\n**not bold**</code></pre>');
});

test('md: pipe tables with numeric columns', () => {
  const md = '| Day | Recovery | Note |\n|---|---:|---|\n| Mon | 62% | **good** |\n| Tue | 41% | <b>x</b> |';
  const html = renderMarkdown(md);
  assert.ok(html.startsWith('<div class="table-wrap"><table class="data"><thead><tr><th>Day</th><th class="num">Recovery</th><th>Note</th></tr></thead>'));
  assert.ok(html.includes('<td class="num">62%</td>'));
  assert.ok(html.includes('<td><strong>good</strong></td>'));
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
  assertSafe(html);
  // Numeric detection without alignment markers; ragged rows are padded.
  const t2 = renderMarkdown('Lift | e1RM\n--- | ---\nBench | 234 lb\n| Squat |');
  assert.ok(t2.includes('<th class="num">e1RM</th>'));
  assert.ok(t2.includes('<tr><td>Squat</td><td class="num"></td></tr>'));
});

test('md: a realistic answer renders only allowed markup', () => {
  const md = [
    '**Short answer:** your lowest recovery days followed alcohol.',
    '',
    '### What the data shows',
    '1. Days with alcohol → **−27 pts** recovery (n=89, q<0.001).',
    '2. Late last meals (<2h before bed) → *lower* deep sleep.',
    '',
    '| Driver | Effect |',
    '|---|---|',
    '| Alcohol | −27 pts |',
    '',
    '> Associations, not causes.',
  ].join('\n');
  const html = renderMarkdown(md);
  assertSafe(html);
  assert.ok(html.includes('<h5>What the data shows</h5>'));
  assert.ok(html.includes('<ol><li>Days with alcohol → <strong>−27 pts</strong> recovery (n=89, q&lt;0.001).</li>'));
  assert.ok(html.includes('<blockquote>Associations, not causes.</blockquote>'));
});
