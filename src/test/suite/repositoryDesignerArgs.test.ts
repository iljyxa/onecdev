import * as assert from 'assert';
import { appendRepositoryArgs } from '../../cli/core/onecCommon';
import { buildRepositoryDesignerArgs } from '../../infra/repository/RepositoryDesignerArgs';

/** Один формат параметров хранилища для Конфигуратора: UI-запуск, операции хранилища и CLI (#86). */
suite('buildRepositoryDesignerArgs (#86)', () => {
  test('путь, пользователь и пароль — отдельными аргументами в порядке F, N, P', () => {
    assert.deepStrictEqual(
      buildRepositoryDesignerArgs({ repoPath: 'tcp://srv/Хранилище', repoUser: 'Разработчик', repoPassword: 'п а р' }),
      ['/ConfigurationRepositoryF', 'tcp://srv/Хранилище', '/ConfigurationRepositoryN', 'Разработчик', '/ConfigurationRepositoryP', 'п а р']
    );
  });

  test('пустой пароль не передаётся', () => {
    assert.deepStrictEqual(
      buildRepositoryDesignerArgs({ repoPath: '/srv/repo', repoUser: 'Admin', repoPassword: '' }),
      ['/ConfigurationRepositoryF', '/srv/repo', '/ConfigurationRepositoryN', 'Admin']
    );
  });

  test('CLI дописывает те же аргументы после уже собранных', () => {
    const args = ['DESIGNER'];
    appendRepositoryArgs(args, { repoPath: '/srv/repo', repoUser: 'Admin', repoPassword: 'x' });
    assert.deepStrictEqual(args, [
      'DESIGNER', '/ConfigurationRepositoryF', '/srv/repo', '/ConfigurationRepositoryN', 'Admin', '/ConfigurationRepositoryP', 'x',
    ]);
  });
});
