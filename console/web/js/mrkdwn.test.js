// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mrkdwn, mrkdwnPlain, safeURL, slackUnescape } from './mrkdwn.js';

/** The only tags the renderer may write, with their only attributes. */
const ALLOWED_TAG = /<(?:\/?(?:strong|em|del|code|pre)|br|\/a|a href="https?:\/\/[^"<>\s]*" target="_blank" rel="noopener noreferrer")>/g;

/** Fails unless every tag in html is one the renderer is allowed to write. */
function assertSafe(html) {
  const rest = html.replace(ALLOWED_TAG, '');
  assert.ok(!/[<>]/.test(rest), `unexpected markup in ${JSON.stringify(html)} (left: ${JSON.stringify(rest)})`);
  assert.ok(!/javascript:/i.test(html.match(/href="[^"]*"/g)?.join('') || ''), 'javascript: href');
}

test('text is HTML-escaped', () => {
  assert.equal(mrkdwn(`a "quoted" 'word'`), 'a &quot;quoted&quot; &#39;word&#39;');
});

test('Slack escapes are decoded once and shown as text', () => {
  assert.equal(mrkdwn('5 &lt; 6 &amp;&amp; 7 &gt; 3'), '5 &lt; 6 &amp;&amp; 7 &gt; 3');
  assert.equal(slackUnescape('&amp;lt;'), '&lt;');
  // A double-escaped entity stays visible as the entity, not a character.
  assert.equal(mrkdwn('&amp;lt;b&amp;gt;'), '&amp;lt;b&amp;gt;');
});

test('bold, italic, strike', () => {
  assert.equal(mrkdwn('*What\'s wrong*'), '<strong>What&#39;s wrong</strong>');
  assert.equal(mrkdwn('an _italic_ word and ~gone~'), 'an <em>italic</em> word and <del>gone</del>');
  assert.equal(mrkdwn('*bold _and italic_*'), '<strong>bold <em>and italic</em></strong>');
  // Markers inside words, with spaces inside, or across lines are text.
  assert.equal(mrkdwn('snake_case_name'), 'snake_case_name');
  assert.equal(mrkdwn('2 * 3 * 4'), '2 * 3 * 4');
  assert.equal(mrkdwn('*not\nbold*'), '*not<br>bold*');
});

test('code: inline and blocks, unformatted', () => {
  assert.equal(mrkdwn('run `kubectl get *pods*`'), 'run <code>kubectl get *pods*</code>');
  assert.equal(
    mrkdwn('look:\n```$ kubectl get pod x\nx   0/1   OOMKilled  _a_ :zzz:```\ndone'),
    'look:<br><pre><code>$ kubectl get pod x\nx   0/1   OOMKilled  _a_ :zzz:</code></pre><br>done',
  );
  assert.equal(mrkdwn('```\nline\n```'), '<pre><code>line</code></pre>');
  // Links in code are their words, not anchors.
  assert.equal(mrkdwn('`<https://x.example/a|label>`'), '<code>label</code>');
  // An unclosed fence is text.
  assert.equal(mrkdwn('``` open'), '``` open');
});

test('links: http(s) only, labelled or bare', () => {
  assert.equal(
    mrkdwn('<https://github.com/o/r/pull/1|Pull Request #1>'),
    '<a href="https://github.com/o/r/pull/1" target="_blank" rel="noopener noreferrer">Pull Request #1</a>',
  );
  assert.equal(mrkdwn('<http://x.example/>'), '<a href="http://x.example/" target="_blank" rel="noopener noreferrer">http://x.example/</a>');
  // &amp; in the URL is Slack's escape for &.
  assert.equal(
    mrkdwn('<https://x.example/q?a=1&amp;b=2|logs>'),
    '<a href="https://x.example/q?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">logs</a>',
  );
  // Formatting characters in a URL are not formatting.
  assert.equal(
    mrkdwn('*see <https://x.example/a_b_c*d|here>*'),
    '<strong>see <a href="https://x.example/a_b_c*d" target="_blank" rel="noopener noreferrer">here</a></strong>',
  );
  assert.equal(mrkdwn('<mailto:a@b.example|mail me>'), 'mail me');
  assert.equal(mrkdwn('<!here> <#C123|platform-ops> <@U1|Gari>'), '@here #platform-ops @Gari');
  assert.equal(safeURL('ftp://x'), '');
  assert.equal(safeURL('https://ok.example/x'), 'https://ok.example/x');
});

test('emoji shortcodes: known ones only', () => {
  assert.equal(mrkdwn(':white_check_mark: *Recommended: Option B*'), '✅ <strong>Recommended: Option B</strong>');
  assert.equal(mrkdwn(':rotating_light: :link: :zzz: :mag:'), '🚨 🔗 💤 🔍');
  assert.equal(mrkdwn(':large_blue_circle: :not_an_emoji:'), ':large_blue_circle: :not_an_emoji:');
});

test('bullets and newlines', () => {
  assert.equal(mrkdwn('*Why*\n• one\n• two'), '<strong>Why</strong><br>• one<br>• two');
});

test('a real report renders its sections, options, links and evidence', () => {
  const report =
    "*What's wrong*\nThe pod is OOM-killed.\n*What to do*\n• *Option A (Revert to working 32Mi):* revert.\n• :white_check_mark: *Recommended: Option B* — more headroom.\n" +
    ':link: <https://console.cloud.google.com/logs/query;query=resource.type%3D%22k8s_container%22;project=p|Cloud Logs>\n```$ kubectl top pod -n online-boutique\nrecommendationservice-556b7d9948-l72m2   10m   30Mi```';
  const html = mrkdwn(report);
  assertSafe(html);
  assert.match(html, /<strong>What&#39;s wrong<\/strong>/);
  assert.match(html, /<strong>Option A \(Revert to working 32Mi\):<\/strong>/);
  assert.match(html, /✅ <strong>Recommended: Option B<\/strong>/);
  assert.match(html, /🔗 <a href="https:\/\/console\.cloud\.google\.com\/logs\/query;query=resource\.type%3D%22k8s_container%22;project=p"[^>]*>Cloud Logs<\/a>/);
  assert.match(html, /<pre><code>\$ kubectl top pod/);
});

// ------------------------------------------------------------------- XSS

test('XSS: a raw <script> tag is text', () => {
  const html = mrkdwn('<script>alert(1)</script>');
  assertSafe(html);
  assert.equal(html, '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('XSS: Slack-escaped &lt;script&gt; stays text after decoding', () => {
  const html = mrkdwn('&lt;script&gt;alert(document.cookie)&lt;/script&gt;');
  assertSafe(html);
  assert.equal(html, '&lt;script&gt;alert(document.cookie)&lt;/script&gt;');
  // Inside code too.
  const code = mrkdwn('```&lt;script&gt;x&lt;/script&gt;``` `&lt;img src=x onerror=alert(1)&gt;`');
  assertSafe(code);
  assert.ok(!code.includes('<script') && !code.includes('<img'));
});

test('XSS: attribute breakout with "><img onerror> is text', () => {
  for (const src of [
    '"><img src=x onerror=alert(1)>',
    '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;',
    '<https://x.example/"><img src=x onerror=alert(1)>|ok>',
    '<https://x.example/" onmouseover="alert(1)|hover>',
    "<https://x.example/' onmouseover='alert(1)|hover>",
    '*"><img src=x onerror=alert(1)>*',
    '_<svg/onload=alert(1)>_',
  ]) {
    const html = mrkdwn(src);
    assertSafe(html);
    assert.ok(!/<(img|svg)/i.test(html), `${src} -> ${html}`);
    // No attribute other than the anchor's three.
    for (const tag of html.match(/<a [^>]*>/g) || []) assert.match(tag, /^<a href="https?:\/\/[^"]*" target="_blank" rel="noopener noreferrer">$/);
  }
});

test('XSS: javascript:, data: and vbscript: links render as text', () => {
  for (const src of [
    '<javascript:alert(1)|click me>',
    '<javascript:alert(1)>',
    '<JaVaScRiPt:alert(1)|x>',
    '<data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==|x>',
    '<vbscript:msgbox(1)|x>',
    '< javascript:alert(1)|x>',
    '<https://ok.example\njavascript:alert(1)|x>',
    '&lt;a href="javascript:alert(1)"&gt;x&lt;/a&gt;',
  ]) {
    const html = mrkdwn(src);
    assertSafe(html);
    assert.ok(!/<a /.test(html), `${src} -> ${html}`);
  }
  assert.equal(mrkdwn('<javascript:alert(1)|click me>'), 'click me');
});

test('XSS: placeholder characters in the input cannot inject held markup', () => {
  const html = mrkdwn('0 <https://ok.example|ok> 1');
  assertSafe(html);
  assert.equal((html.match(/<a /g) || []).length, 1);
});

test('plain text for one line', () => {
  assert.equal(mrkdwnPlain(':rotating_light: *recommendationservice in boutique-prod* &amp; <https://x|PR #1>'), '🚨 recommendationservice in boutique-prod & PR #1');
});
