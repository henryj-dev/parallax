import { createSocket } from "node:dgram";
import { isIP } from "node:net";
import { createServer, type AddressInfo } from "node:net";

/**
 * 포트를 고르는 일은 **경합이다.** 이 파일은 그 경합을 없애지 않는다 — 한 곳으로 모으고,
 * 잃었을 때 다시 고르게 한다.
 *
 * 커널에게 빈 포트를 물어보는 유일한 방법은 `listen(0)` 이고, 그 답을 다른 프로세스에게
 * 주려면 먼저 놓아야 한다. 놓은 뒤 상대가 잡기까지의 창은 닫을 수 없다. 그래서 정직한
 * 목표는 「경합 없음」이 아니라 **「지면 다시 시도」**다.
 *
 * ⚠️ **같은 함수가 다섯 벌 있었고, 그중 하나만 이 사실을 알고 있었다.**
 * `test/dns/server.test.ts` 는 재시도와 UDP 재확인을 갖췄고 그 이유를 적어 두었다 —
 * 「부하가 걸린 기계에서 타임아웃에 이르고 이 기계에서는 절대 안 나는」 방식으로 실패한다고.
 * `test/http/**` 의 네 벌은 바이트 동일한 채 그 교훈을 받지 못했다. 합의해야 하는 다섯
 * 사본은 결국 합의하지 않는다.
 *
 * 📌 2026-08-31 에 스위트가 한 번 원인 미상으로 1건 실패했고(31회 미재현),
 * [`docs/test-flakes.md`](../../docs/test-flakes.md) 가 그 관찰을 들고 있다. 이 파일은 그
 * 관찰의 **원인이라고 주장하지 않는다** — 증명하지 못했다. 재현과 무관하게 실재하는
 * 경합이라 고치는 것이고, 만들어 내는 증상의 종류가 관찰된 것과 같은 부류일 뿐이다.
 */

/** 재시도를 요청하는 신호. 다른 실패와 섞이면 재시도가 실패를 숨긴다. */
export class AddressInUse extends Error {
  override readonly name = "AddressInUse";
}

/**
 * 커널이 지금 비어 있다고 답한 포트.
 *
 * `udp` 를 요구하면 TCP 로 고른 뒤 UDP 로도 잡히는지 확인한다 — 두 전송은 포트 공간이
 * 달라서, TCP 로만 확인한 포트는 UDP 를 쓰려는 호출자에게 **절반만 맞는 답**이다. 그
 * 경우의 실패는 던지지도 답하지도 않고 그냥 멈추는 쪽이라 타임아웃으로만 드러난다.
 */
export async function freePort(host = "127.0.0.1", { udp = false } = {}): Promise<number> {
  for (let attempt = 8; ; attempt -= 1) {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, host, resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    if (!udp) return port;
    const datagram = createSocket(isIP(host) === 6 ? "udp6" : "udp4");
    try {
      await new Promise<void>((resolve, reject) => {
        datagram.once("error", reject);
        datagram.bind(port, host, resolve);
      });
    } catch (error) {
      // TCP 로는 비었고 UDP 로는 잡혀 있다는 것은 오류가 아니라 답이다. 호출자가 절반만
      // 가질 수 있는 포트를 건네지 말고 커널에 다시 묻는다.
      datagram.close();
      if (attempt <= 1 || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      continue;
    }
    await new Promise<void>((resolve) => datagram.close(resolve));
    return port;
  }
}

/**
 * 별도 프로세스가 그 포트를 잡아야 할 때. 지면 다시 고른다.
 *
 * `run` 이 `AddressInUse` 를 던지면 새 포트로 다시 부른다. 다른 오류는 그대로 올린다 —
 * 모든 실패에 재시도를 걸면 재시도가 진짜 실패를 숨기고, 그러면 스위트는 조용히 세 배
 * 느려지면서 같은 답을 낸다.
 */
export async function onFreePort<T>(
  run: (port: number) => Promise<T>,
  { host = "127.0.0.1", attempts = 3 } = {},
): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const port = await freePort(host);
    try {
      return await run(port);
    } catch (error) {
      if (!(error instanceof AddressInUse)) throw error;
      last = error;
    }
  }
  throw new AddressInUse(`${attempts}번 시도했지만 포트를 잡지 못했다: ${String((last as Error | undefined)?.message ?? "")}`);
}

/**
 * 자식이 남긴 출력이 「포트를 이미 누가 쓴다」고 말하는지.
 *
 * 문자열로 판정하는 이유는 이것이 **다른 프로세스의** 실패이기 때문이다 — 오류 객체가
 * 프로세스 경계를 넘지 않으므로 남는 것은 그 프로세스가 적어 놓은 말뿐이다.
 */
export function isAddressInUse(log: string): boolean {
  return log.includes("EADDRINUSE");
}
