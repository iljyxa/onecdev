// Выбор портов для локального crserver в скриптах example/tools (стенд crs, пересборка корпуса блокировок).
// Порты -range проверяются целиком, а не только начало диапазона (issues #122, #143): занятый порт внутри
// диапазона роняет старт crserver без связи с логикой скрипта. Порт -port в диапазон не входит.
import * as net from 'node:net';

export const CRSERVER_RANGE_SIZE = 10;
const RANGE_ATTEMPTS = 20;

/** Свободный порт на 127.0.0.1, выданный системой. */
export function freePort() {
  return new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}

function canListen(port) {
  return new Promise((r) => {
    const s = net.createServer();
    s.once('error', () => r(false));
    s.listen(port, '127.0.0.1', () => s.close(() => r(true)));
  });
}

/** Начало свободного диапазона CRSERVER_RANGE_SIZE портов, не пересекающегося с exceptPort. */
export async function freeRangeStart(exceptPort) {
  for (let attempt = 0; attempt < RANGE_ATTEMPTS; attempt += 1) {
    const base = await freePort();
    if (base + CRSERVER_RANGE_SIZE - 1 > 65535 || (exceptPort >= base && exceptPort < base + CRSERVER_RANGE_SIZE)) continue;
    const ports = Array.from({ length: CRSERVER_RANGE_SIZE }, (_, i) => base + i);
    const free = await Promise.all(ports.map(canListen));
    if (free.every(Boolean)) return base;
  }
  throw new Error(`Не найден свободный диапазон из ${String(CRSERVER_RANGE_SIZE)} портов за ${String(RANGE_ATTEMPTS)} попыток`);
}

/** Аргумент -range crserver для диапазона, начинающегося с start. */
export function crserverRangeArg(start) {
  return `${String(start)}:${String(start + CRSERVER_RANGE_SIZE - 1)}`;
}
