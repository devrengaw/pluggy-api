// pluggy.js
import { createRequire } from "module";
import dotenv from "dotenv";
dotenv.config();

const require = createRequire(import.meta.url);
const Pluggy = require("pluggy-sdk");

const pluggyClient = new Pluggy({
  clientId: process.env.PLUGGY_CLIENT_ID,
  clientSecret: process.env.PLUGGY_CLIENT_SECRET,
});

export default pluggyClient;
