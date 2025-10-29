import { PluggyClient } from "pluggy-sdk";
import dotenv from "dotenv";
dotenv.config();

const pluggyClient = new PluggyClient({
  clientId: process.env.PLUGGY_CLIENT_ID,
  clientSecret: process.env.PLUGGY_CLIENT_SECRET,
});

export default pluggyClient;
