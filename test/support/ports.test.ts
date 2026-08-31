import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { after, describe, it } from "node:test";
import { AddressInUse, freePort, isAddressInUse, onFreePort } from "./ports.ts";

/**
 * 포트를 고르는 헬퍼의 음성 대조.
 *
 * 이 헬퍼는 경합을 **없애지 않는다** — 한 곳으로 모으고, 지면 다시 고른다. 그래서 확인할
 * 것은 「경합이 없다」가 아니라 셋이다: 고른 포트가 정말 비어 있나, 재시도가 실제로 걸리나,
 * 그리고 **재시도가 다른 실패를 숨기지 않나.**
 *
 * 마지막 것이 이 파일의 이유다. 모든 실패에 재시도를 걸면 스위트는 조용히 세 배 느려지면서
 * 같은 답을 내고, 그때 초록은 「통과」가 아니라 「세 번 실패했고 마지막에 우연히」가 된다.
 */

const closing: Array<() => void> = [];
after(() => { for (const close of closing) close(); });

describe("포트를 고르는 일", () => {
  it("고른 포트는 그 순간 비어 있다", async () => {
    const port = await freePort();
    assert.ok(port > 0 && port < 65_536, `포트 범위: ${port}`);
    const server = createServer();
    closing.push(() => server.close());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  });

  it("UDP 를 요구하면 UDP 로도 잡히는 포트를 준다", async () => {
    // TCP 만 확인한 포트는 UDP 를 쓰려는 호출자에게 절반만 맞는 답이다. 그 경우의 실패는
    // 던지지도 답하지도 않고 멈추는 쪽이라 타임아웃으로만 드러난다 — DNS 스위트가 그것을
    // 겪고 나서 이 확인을 붙였고, 그 사본만 알고 있었다.
    const port = await freePort("127.0.0.1", { udp: true });
    const datagram = createSocket("udp4");
    closing.push(() => datagram.close());
    await new Promise<void>((resolve, reject) => {
      datagram.once("error", reject);
      datagram.bind(port, "127.0.0.1", resolve);
    });
  });

  it("서로 다른 호출은 서로 다른 포트를 준다", async () => {
    // 같은 포트를 두 번 주면 두 번째 호출자는 무조건 진다. 커널이 그렇게 답하지 않는다는
    // 것을 믿지 않고 확인한다 — 이 헬퍼가 하나 캐싱하는 식으로 바뀌면 여기서 걸린다.
    const ports = await Promise.all([freePort(), freePort(), freePort()]);
    assert.equal(new Set(ports).size, ports.length, `중복: ${ports.join(" ")}`);
  });
});

describe("포트를 잃었을 때", () => {
  it("AddressInUse 면 다시 고른다", async () => {
    const seen: number[] = [];
    const value = await onFreePort(async (port) => {
      seen.push(port);
      if (seen.length < 3) throw new AddressInUse("EADDRINUSE");
      return "성공";
    });
    assert.equal(value, "성공");
    assert.equal(seen.length, 3, "두 번 지고 세 번째에 성공한다");
    assert.equal(new Set(seen).size, 3, "매번 새 포트를 고른다 — 같은 포트로 다시 시도하면 뜻이 없다");
  });

  it("다른 실패는 재시도하지 않고 그대로 올린다", async () => {
    // 🔑 이 파일의 이유. 모든 실패에 재시도를 걸면 재시도가 진짜 실패를 숨기고, 그러면
    // 초록은 「통과」가 아니라 「세 번 실패했고 마지막에 우연히」가 된다.
    let attempts = 0;
    await assert.rejects(
      () => onFreePort(async () => { attempts += 1; throw new Error("서버가 다른 이유로 죽었다"); }),
      /서버가 다른 이유로 죽었다/u,
    );
    assert.equal(attempts, 1, "한 번만 부른다");
  });

  it("계속 지면 포기하고, 몇 번 시도했는지 말한다", async () => {
    let attempts = 0;
    await assert.rejects(
      () => onFreePort(async () => { attempts += 1; throw new AddressInUse("EADDRINUSE"); }, { attempts: 2 }),
      (error: Error) => {
        assert.equal(error.name, "AddressInUse");
        assert.match(error.message, /2번/u, "몇 번 시도했는지가 메시지에 있다");
        return true;
      },
    );
    assert.equal(attempts, 2, "무한히 돌지 않는다");
  });

  it("자식이 남긴 말에서 포트 충돌을 알아본다", () => {
    // 오류 객체는 프로세스 경계를 넘지 않는다. 남는 것은 그 프로세스가 적어 놓은 말뿐이라
    // 문자열로 판정하고, 그래서 무엇이 걸리고 무엇이 안 걸리는지를 못 박아 둔다.
    assert.equal(isAddressInUse("Error: listen EADDRINUSE: address already in use 127.0.0.1:3000"), true);
    assert.equal(isAddressInUse("parallax: configuration could not be read"), false, "다른 기동 실패는 재시도 대상이 아니다");
    assert.equal(isAddressInUse(""), false);
  });
});
