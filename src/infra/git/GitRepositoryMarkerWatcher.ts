import * as fs from 'fs';
import * as path from 'path';

/** Проверяет только Git-маркеры каталогов, в которых Git может найти корень рабочей папки. */
export function watchGitRepositoryMarkers(workspaceRoot: string, onChange: () => void): { dispose(): void } {
  const markers: string[] = [];
  let folder = path.resolve(workspaceRoot);
  try {
    folder = fs.realpathSync(folder);
  } catch {
    // Папку могли удалить до завершения активации. Предки по-прежнему доступны для проверки.
  }
  for (;;) {
    const gitEntry = path.join(folder, '.git');
    markers.push(gitEntry, path.join(gitEntry, 'HEAD'), path.join(gitEntry, 'objects'), path.join(gitEntry, 'refs'));
    const parent = path.dirname(folder);
    if (parent === folder) {
      break;
    }
    folder = parent;
  }

  // Git создаёт HEAD до завершения init. Отслеживаем и каталоги, необходимые
  // для распознавания репозитория, чтобы перепроверить корень после их появления.
  let known = markers.map((marker) => fs.existsSync(marker));
  const timer = setInterval(() => {
    const current = markers.map((marker) => fs.existsSync(marker));
    if (current.some((exists, index) => exists !== known[index])) {
      known = current;
      onChange();
    }
  }, 750);
  timer.unref();
  return { dispose: () => clearInterval(timer) };
}
