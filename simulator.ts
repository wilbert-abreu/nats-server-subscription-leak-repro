import { connect, NatsConnection, JetStreamManager, JetStreamClient, consumerOpts, JetStreamSubscription, StringCodec } from "nats";

const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";
const NATS_USER = process.env.NATS_USER || "";
const NATS_PASS = process.env.NATS_PASS || "";
const MODE = process.env.MODE || "consumer";
const STREAM_NAME = process.env.STREAM_NAME || "events";
const NUM_CONSUMERS = parseInt(process.env.NUM_CONSUMERS || "20");
const CONSUMER_LIFETIME_MS = parseInt(process.env.CONSUMER_LIFETIME_MS || "5000");
const RECONNECT_DELAY_MS = parseInt(process.env.RECONNECT_DELAY_MS || "100");

interface ConsumerInfo {
  id: string;
  subject: string;
  createdAt: number;
  subscription: JetStreamSubscription | null;
  messageCount: number;
}

const activeConsumers: Map<string, ConsumerInfo> = new Map();
let totalCreated = 0;
let totalClosed = 0;
let totalReconnects = 0;
let createErrors = 0;
const startTime = Date.now();
const sc = StringCodec();

const SUBJECTS = [
  "events.sensor.station1.>",
  "events.sensor.station2.>",
  "events.sensor.station3.>",
  "events.telemetry.module1.>",
  "events.telemetry.module2.>",
  "events.>",
];

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForJetStream(jsm: JetStreamManager, maxRetries = 30): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await jsm.streams.list().next();
      return true;
    } catch (e) {
      console.log(`Waiting for JetStream... (attempt ${i + 1}/${maxRetries})`);
      await sleep(2000);
    }
  }
  return false;
}

async function createStream(jsm: JetStreamManager): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await jsm.streams.add({
        name: STREAM_NAME,
        subjects: ["events.>"],
        retention: "limits" as any,
        max_msgs: 10000000,
        max_bytes: 1024 * 1024 * 1024,
        max_age: 3600 * 1000000000 * 24,
        storage: "file" as any,
        num_replicas: 1,
        discard: "old" as any,
      });
      console.log(`Stream ${STREAM_NAME} created`);
      return;
    } catch (e: any) {
      if (e.message?.includes("already in use") || e.code === "10058") {
        console.log(`Stream ${STREAM_NAME} already exists`);
        return;
      }
      console.log(`Stream create attempt ${attempt + 1} failed: ${e.message}`);
      await sleep(3000);
    }
  }
}

async function createOrderedConsumer(js: JetStreamClient, id: string, subject: string): Promise<ConsumerInfo> {
  const info: ConsumerInfo = {
    id,
    subject,
    createdAt: Date.now(),
    subscription: null,
    messageCount: 0,
  };

  try {
    const opts = consumerOpts();
    opts.orderedConsumer();
    opts.deliverLastPerSubject();
    
    info.subscription = await js.subscribe(subject, opts);
    totalCreated++;
    
    (async () => {
      try {
        for await (const msg of info.subscription!) {
          info.messageCount++;
        }
      } catch (e) {}
    })();

  } catch (e: any) {
    createErrors++;
    if (createErrors % 10 === 1) {
      console.error(`[${new Date().toISOString()}] Create error #${createErrors}: ${e.message}`);
    }
  }

  return info;
}

async function closeConsumer(info: ConsumerInfo): Promise<void> {
  if (info.subscription) {
    try {
      await info.subscription.destroy();
      totalClosed++;
    } catch (e) {}
  }
}

async function runConsumerLoop(js: JetStreamClient, consumerId: number): Promise<void> {
  const subject = SUBJECTS[consumerId % SUBJECTS.length];
  const id = `consumer_${consumerId}`;
  
  while (true) {
    const info = await createOrderedConsumer(js, id, subject);
    activeConsumers.set(id, info);
    
    await sleep(CONSUMER_LIFETIME_MS);
    
    await closeConsumer(info);
    activeConsumers.delete(id);
    totalReconnects++;
    
    await sleep(RECONNECT_DELAY_MS);
  }
}

async function runPublisher(nc: NatsConnection): Promise<void> {
  console.log("Running in PUBLISHER mode");
  let msgCount = 0;
  
  const subjects = [
    "events.sensor.station1.data",
    "events.sensor.station2.data",
    "events.telemetry.module1.data",
    "events.telemetry.module2.data",
  ];
  
  setInterval(() => {
    for (let i = 0; i < 50; i++) {
      const subject = subjects[Math.floor(Math.random() * subjects.length)];
      const payload = JSON.stringify({
        timestamp: new Date().toISOString(),
        value: Math.random() * 100,
        seq: msgCount++,
      });
      nc.publish(subject, sc.encode(payload));
    }
  }, 100);
  
  setInterval(() => {
    console.log(`[${new Date().toISOString()}] Published ${msgCount} messages`);
  }, 60000);
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

async function printStats(): Promise<void> {
  const uptime = Date.now() - startTime;
  const leaked = totalCreated - totalClosed - activeConsumers.size;
  
  console.log("");
  console.log("=".repeat(60));
  console.log(`[${new Date().toISOString()}] OrderedConsumer Churn Stats`);
  console.log("=".repeat(60));
  console.log(`Uptime:              ${formatDuration(uptime)}`);
  console.log(`Active consumers:    ${activeConsumers.size}`);
  console.log(`Total created:       ${totalCreated}`);
  console.log(`Total closed:        ${totalClosed}`);
  console.log(`Total reconnects:    ${totalReconnects}`);
  console.log(`Create errors:       ${createErrors}`);
  console.log(`CLIENT LEAKED:       ${leaked}`);
  console.log(`Churn rate:          ${(totalReconnects / (uptime / 1000 / 60)).toFixed(1)} reconnects/min`);
  console.log("=".repeat(60));
  console.log("");
}

async function main(): Promise<void> {
  console.log("NATS Subscription Leak Reproduction");
  console.log("====================================");
  console.log(`NATS URL: ${NATS_URL}`);
  console.log(`Mode: ${MODE}`);
  console.log(`Num Consumers: ${NUM_CONSUMERS}`);
  console.log(`Consumer Lifetime: ${CONSUMER_LIFETIME_MS}ms`);
  console.log(`Reconnect Delay: ${RECONNECT_DELAY_MS}ms`);
  console.log("");

  await sleep(10000);

  const connectOpts: any = {
    servers: NATS_URL,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2000,
    timeout: 30000,
  };
  if (NATS_USER) {
    connectOpts.user = NATS_USER;
    connectOpts.pass = NATS_PASS;
  }
  const nc = await connect(connectOpts);

  console.log(`Connected to ${nc.getServer()}`);

  if (MODE === "publisher") {
    await runPublisher(nc);
  } else {
    const jsm = await nc.jetstreamManager();
    const js = nc.jetstream();
    
    console.log("Waiting for JetStream cluster to be ready...");
    const ready = await waitForJetStream(jsm);
    if (!ready) {
      console.error("JetStream not ready after max retries");
      process.exit(1);
    }
    console.log("JetStream is ready");
    
    await createStream(jsm);
    
    console.log(`Starting ${NUM_CONSUMERS} OrderedConsumer loops...`);
    for (let i = 0; i < NUM_CONSUMERS; i++) {
      runConsumerLoop(js, i);
      await sleep(100);
    }
    
    setInterval(printStats, 30000);
    setTimeout(printStats, 15000);
  }

  await nc.closed();
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
