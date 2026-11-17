/**
 * Параметры хранилища в командной строке Конфигуратора (`/ConfigurationRepositoryF|N|P`).
 * Единственный построитель для интерактивного запуска Конфигуратора, пакетных операций хранилища
 * и CLI (#86): три копии этой последовательности могли разойтись по формату.
 */
export interface RepositoryDesignerCredentials {
  readonly repoPath: string;
  readonly repoUser: string;
  readonly repoPassword: string;
}

/** Без пароля ключ `/ConfigurationRepositoryP` не передаётся — пользователь хранилища без пароля. */
export function buildRepositoryDesignerArgs(credentials: RepositoryDesignerCredentials): string[] {
  const args = ['/ConfigurationRepositoryF', credentials.repoPath, '/ConfigurationRepositoryN', credentials.repoUser];
  if (credentials.repoPassword) {
    args.push('/ConfigurationRepositoryP', credentials.repoPassword);
  }
  return args;
}
