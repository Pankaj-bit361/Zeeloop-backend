"use strict";
const { START } = require("./start");
const { TRIAL } = require("./trial");
const { ACCOUNT } = require("./account");
const { USAGE } = require("./usage");
const { BILLING } = require("./billing");
const { RESULTS } = require("./results");
const { CAMPAIGNS } = require("./campaigns");

// Every lifecycle template, in the order they appear in Volanea and the preview.
const TEMPLATES = [...START, ...TRIAL, ...ACCOUNT, ...USAGE, ...BILLING, ...RESULTS, ...CAMPAIGNS];

module.exports = { TEMPLATES };
