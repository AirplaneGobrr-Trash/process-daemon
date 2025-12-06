import { ProcClient } from "./projects/client";

const pClient = new ProcClient();

const list = await pClient.list();

console.log(list)