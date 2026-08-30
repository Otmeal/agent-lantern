import {
  loadDaemonConfiguration,
  sharedConfigurationFilePath,
  updateSharedConfigurationPort,
} from "./configuration.js";
import { resolveListeningPort } from "./port.js";
import { buildServer } from "./server.js";

async function start(): Promise<void> {
  const configuration = loadDaemonConfiguration();
  const server = await buildServer({ configuration });

  const port = configuration.allowAutomaticPortFallback
    ? await resolveListeningPort(configuration.bindAddress, configuration.port)
    : configuration.port;

  await server.listen({ host: configuration.bindAddress, port });

  if (port !== configuration.port) {
    updateSharedConfigurationPort(port);
    server.log.warn(
      `連接埠 ${configuration.port} 無法綁定（Windows 上常見原因是 WSL 2 或 Docker Desktop 的 Hyper-V ` +
        `保留了該範圍），已改用 ${port} 並更新設定檔。若要固定連接埠，請以系統管理員執行：` +
        `netsh int ipv4 add excludedportrange protocol=tcp startport=${configuration.port} numberofports=1`,
    );
  }

  if (!process.env.AGENT_LANTERN_TOKEN) {
    server.log.info(
      `Token 與連線設定已自動產生並存放於 ${sharedConfigurationFilePath()}；` +
        "開啟 Agent Lantern overlay 的「設定」面板即可複製給遠端 reporter 使用。",
    );
  }
}

start().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
