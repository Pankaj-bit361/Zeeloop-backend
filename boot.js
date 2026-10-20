"use strict";
// Production entry point (npm start). Loads the API's settings from AWS Secrets Manager, then starts server.js.
//
// ZEALOOP_SECRET_ID names one JSON secret of NAME → value pairs (README.md → "Verification and production setup"). A setting that is
// already in the environment, such as an Elastic Beanstalk environment property, wins over the secret, and empty
// values are skipped. Without ZEALOOP_SECRET_ID (local development) it just starts server.js, which reads .env.
//
// Settings are read once at start: after changing the secret, restart the app servers (Elastic Beanstalk →
// Actions → Restart app server(s)).
const { loadSecrets } = require("./config/secrets");

// The second handler catches only the secret's failure; a server.js startup error surfaces as itself.
loadSecrets().then(
    (set) => {
        if (set) console.log(`Boot: loaded ${set} settings from ${process.env.ZEALOOP_SECRET_ID}`);
        require("./server");
    },
    (error) => {
        console.error(`Boot: could not load settings from ${process.env.ZEALOOP_SECRET_ID}: ${error.message}`);
        process.exit(1);
    },
);
