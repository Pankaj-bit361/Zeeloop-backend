"use strict";
// A template is { key, name, type, event, subject, parts }:
//   key      stable handle used by workflows and the sync; never reuse one for a different email
//   name     the name in Volanea; the sync matches on it, so renaming creates a new template
//   type     transactional reaches people who unsubscribed from product mail
//            (security, billing, "something broke"); everything else is marketing
//   event    the event whose fields the template may use; null for campaign bases sent by hand
//   parts    what layout.renderEmail dresses: preheader, eyebrow, heading, tint, body[], reason

const PREFIX = "Zealoop · ";

const hi = `Hi {{firstName | "there"}},`;

const t = (key, title, type, event, subject, parts) => ({ key, name: `${PREFIX}${title}`, type, event, subject, parts });

module.exports = { PREFIX, hi, t };
