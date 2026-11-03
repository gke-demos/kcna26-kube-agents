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

// Slack mrkdwn to safe HTML for the thread view. Pure, no DOM.
//
// Every character of the message is HTML-escaped; the only markup in the
// output is what this module writes: <pre><code>, <code>, <strong>, <em>,
// <del>, <br> and <a href="http(s)://…" target="_blank" rel="noopener
// noreferrer">. Slack escapes a literal <, > and & in message text as &lt;
// &gt; &amp;, so an unescaped <…> is always one of Slack's own tokens (a
// link, a channel, a mention); those escapes are decoded only to read a
// token or a run of text, and the result is escaped again.

import { esc } from './format.js';

/** The emoji shortcodes the agents and the event watcher use. Others stay as text. */
export const EMOJI = {
  white_check_mark: '✅',
  rotating_light: '🚨',
  large_yellow_circle: '🟡',
  red_circle: '🔴',
  link: '🔗',
  zzz: '💤',
  arrow_upper_right: '↗',
  twisted_rightwards_arrows: '🔀',
  card_index_dividers: '🗂',
  wrench: '🔧',
  warning: '⚠️',
  x: '❌',
  heavy_check_mark: '✔️',
  seedling: '🌱',
  eyes: '👀',
  mag: '🔍',
};

// Placeholders for rendered pieces (links, inline code) while the
// formatter runs over the rest: private-use characters, stripped from the
// input first so a message cannot forge one.
const PH_OPEN = '\uE000';
const PH_CLOSE = '\uE001';
const PH_STRIP = /[\uE000\uE001]/g;
const PH_RE = /\uE000(\d+)\uE001/g;

const FENCE_RE = /```([\s\S]*?)```/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
// A token never spans a placeholder (inline code inside <…> is not a link).
const TOKEN_RE = /<([^<>\n\uE000\uE001]+)>/g;
const HTTP_URL_RE = /^https?:\/\/[^\s<>"'`]+$/i;
const EMOJI_RE = /:([a-z0-9_+-]+):/g;

// Bold, italic and strike: the marker opens after a start, a space or
// punctuation, closes before an end, a space or punctuation, and wraps text
// on one line that neither starts nor ends with a space.
const BOUNDARY_BEFORE = '(^|[^\\p{L}\\p{N}_])';
const BOUNDARY_AFTER = '(?=$|[^\\p{L}\\p{N}_])';
function styleRe(mark) {
  const m = mark === '*' ? '\\*' : mark;
  return new RegExp(`${BOUNDARY_BEFORE}${m}([^${m}\\s\\n](?:[^${m}\\n]*?[^${m}\\s\\n])?)${m}${BOUNDARY_AFTER}`, 'gmu');
}
const STYLES = [
  [styleRe('*'), 'strong'],
  [styleRe('_'), 'em'],
  [styleRe('~'), 'del'],
];

/** Decodes Slack's three escapes (&lt; &gt; &amp;) to the characters they stand for. */
export function slackUnescape(s) {
  return String(s ?? '').replace(/&(lt|gt|amp);/g, (_, n) => ({ lt: '<', gt: '>', amp: '&' })[n]);
}

/** Text from Slack, shown as text: decoded, then HTML-escaped. */
function text(s) {
  return esc(slackUnescape(s));
}

/** An http(s) URL from a Slack token, or '' when it is anything else. */
export function safeURL(raw) {
  const u = slackUnescape(raw).trim();
  return HTTP_URL_RE.test(u) ? u : '';
}

/** The words a Slack <…> token shows, as escaped HTML (a link only for http(s)). */
function token(inner, plain) {
  const bar = inner.indexOf('|');
  const target = bar >= 0 ? inner.slice(0, bar) : inner;
  const label = bar >= 0 ? inner.slice(bar + 1) : '';
  const url = safeURL(target);
  if (url) {
    const shown = text(label || target);
    return plain ? shown : `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${shown}</a>`;
  }
  // Slack's own tokens: <!here>, <#C123|name>, <@U123|name>.
  if (target.startsWith('!')) return text(`@${label || target.slice(1)}`);
  if (target.startsWith('#') && label) return text(`#${label}`);
  if (target.startsWith('@') && label) return text(`@${label}`);
  // A labelled link to anything but http(s) (javascript:, data:, mailto:):
  // its label as text. Anything else: the brackets and all, as text.
  if (label) return text(label);
  return text(`<${inner}>`);
}

/** Code (a block or inline): no formatting, Slack's links shown as their words. */
function code(s) {
  let out = '';
  let last = 0;
  for (const m of s.matchAll(TOKEN_RE)) {
    out += text(s.slice(last, m.index)) + token(m[1], true);
    last = m.index + m[0].length;
  }
  return out + text(s.slice(last));
}

/** Formats text outside code: inline code, links, emoji, bold, italic, strike, line breaks. */
function prose(s) {
  const held = [];
  const hold = (html) => `${PH_OPEN}${held.push(html) - 1}${PH_CLOSE}`;
  // Inline code, then Slack's tokens, become placeholders; the text left is
  // decoded, escaped and formatted; the placeholders go back last.
  const coded = s.replace(INLINE_CODE_RE, (_, body) => hold(`<code>${code(body)}</code>`));
  let out = '';
  let last = 0;
  for (const m of coded.matchAll(TOKEN_RE)) {
    out += text(coded.slice(last, m.index)) + hold(token(m[1], false));
    last = m.index + m[0].length;
  }
  out += text(coded.slice(last));
  out = out.replace(EMOJI_RE, (all, name) => EMOJI[name] || all);
  for (const [re, tag] of STYLES) out = out.replace(re, (_, pre, body) => `${pre}<${tag}>${body}</${tag}>`);
  out = out.replace(/\n/g, '<br>');
  return out.replace(PH_RE, (_, i) => held[Number(i)]);
}

/**
 * Renders Slack mrkdwn as HTML that is safe to assign to innerHTML.
 * @param {string} src the message's text as Slack sends it
 * @returns {string}
 */
export function mrkdwn(src) {
  const s = String(src ?? '').replace(PH_STRIP, '');
  let out = '';
  let last = 0;
  for (const m of s.matchAll(FENCE_RE)) {
    out += prose(s.slice(last, m.index));
    const body = m[1].replace(/^[ \t]*\n/, '').replace(/\n[ \t]*$/, '');
    out += `<pre><code>${code(body)}</code></pre>`;
    last = m.index + m[0].length;
  }
  return out + prose(s.slice(last));
}

/** Plain text of a message for one line (titles, tooltips): tokens to words, no markup. */
export function mrkdwnPlain(src) {
  return slackUnescape(
    String(src ?? '')
      .replace(TOKEN_RE, (_, inner) => {
        const bar = inner.indexOf('|');
        return bar >= 0 ? inner.slice(bar + 1) : inner.replace(/^[!@#]/, '');
      })
      .replace(EMOJI_RE, (all, name) => EMOJI[name] || all)
      .replace(/```|[*_~`]/g, ''),
  );
}
