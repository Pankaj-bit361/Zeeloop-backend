"use strict";
// Loads the API's settings from one AWS Secrets Manager secret (boot.js; README.md → "Verification and production setup").

/** Copies the secret's values into `env`; returns how many it set. */
async function loadSecrets({ id = process.env.ZEALOOP_SECRET_ID, env = process.env, client } = {}) {
    if (!id) return 0;
    const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
    if (!client) {
        // A secret ARN carries its region; a bare name uses ZEALOOP_SECRET_REGION.
        const region = id.startsWith("arn:") ? id.split(":")[3] : process.env.ZEALOOP_SECRET_REGION || "ap-south-1";
        client = new SecretsManagerClient({ region });
    }
    const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: id }));
    let values;
    try {
        values = JSON.parse(SecretString || "");
    } catch {
        throw new Error(`Secret ${id} is not JSON (store it as key/value pairs)`);
    }
    let set = 0;
    for (const [name, value] of Object.entries(values)) {
        if (value === "" || value == null || env[name] !== undefined) continue;
        env[name] = String(value);
        set++;
    }
    return set;
}

module.exports = { loadSecrets };
