// Хеш пароля хранилища. Хеш равнозначен паролю (сервер сверяет именно его), поэтому в сообщения ошибок
// и логи не попадает; маскировка хешей в телах crs — maskCrsSecrets (infra/xml/crs/CrsEnvelope).
import { createHash } from 'crypto';

/** md5 от пароля в UTF-16LE без BOM, hex в нижнем регистре — как у Конфигуратора. */
export function crsPasswordHash(password: string): string {
  return createHash('md5').update(password, 'utf16le').digest('hex');
}
