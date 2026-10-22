# Копия в OneDrive: настройка для своей сборки

«Копия в OneDrive» — это ваш зашифрованный файл `.veil`, который Veil раз в день сохраняет в ваш OneDrive. Если вы потеряли компьютер, на новом нужно войти через Microsoft и ввести пароль копии.

## Что видит Microsoft

| Видит | Не видит |
| --- | --- |
| Что в вашем OneDrive лежит файл `veil-xxxxxxxxxxxx.veil` | Переписку, контакты, «Избранное», ключи шифрования |
| Его размер и время изменения | Ваше имя в Veil, адрес сервера, собеседников |
| Что вы входили в приложение Veil (журнал входов Microsoft) | Пароль Veil и пароль копии |

- Файл шифруется на компьютере ключом из **пароля копии**: scrypt N=2¹⁷, затем XChaCha20-Poly1305. Veil не хранит пароль копии и не может его восстановить.
- Veil запрашивает только одно разрешение: `Files.ReadWrite.AppFolder`. Это доступ к папке «Приложения/Veil», а не ко всему OneDrive. Ещё нужно `offline_access`, чтобы делать копию каждый день без повторного входа.
- Вход идёт в системном браузере по OAuth 2.0 с PKCE (RFC 8252). Секрета клиента в приложении нет. Сервер Veil в этом не участвует.
- Токен входа хранится только внутри зашифрованного хранилища Veil. Он не попадает ни в файл `.veil`, ни в копию на сервере.
- Пароль копии должен быть не короче 10 символов и не простым: у кого окажется файл, сможет подбирать пароль без ограничений.

## Регистрация приложения (один раз, бесплатно)

1. Откройте https://entra.microsoft.com (или https://portal.azure.com → **Microsoft Entra ID**) и войдите любым аккаунтом Microsoft.
2. **App registrations → New registration**:
   - **Name**: `Veil` — такое название будет у папки в OneDrive;
   - **Supported account types**: *Accounts in any organizational directory and personal Microsoft accounts*;
   - **Redirect URI**: платформа **Public client/native (mobile & desktop)**, адрес `http://localhost`.
   Нажмите **Register**.
3. На странице приложения скопируйте **Application (client) ID** — строку вида `1a2b3c4d-....`. Это не секрет.
4. **API permissions → Add a permission → Microsoft Graph → Delegated permissions**: отметьте `Files.ReadWrite.AppFolder` и `offline_access` и нажмите **Add permissions**. Разрешение `User.Read` можно удалить, оно не нужно.
5. **Authentication**: проверьте, что адрес `http://localhost` есть в списке **Mobile and desktop applications**. Секреты и сертификаты не создавайте: приложению на компьютере они не нужны.

## Подключение к сборке

На GitHub в репозитории откройте **Settings → Secrets and variables → Actions → Variables → New repository variable**:

- **Name**: `VEIL_MS_CLIENT_ID`
- **Value**: Application (client) ID из шага 3

После этого запустите сборку (**Actions → Build desktop apps → Run workflow**). Без этой переменной функция в сборке скрыта, и в настройках написано «вход через Microsoft не настроен».

Для локальной сборки: `VEIL_MS_CLIENT_ID=... npm run build`.

> Пока приложение не прошло проверку издателя (Publisher verification в Entra), Microsoft показывает на странице входа пометку «не проверено». Личным аккаунтам Microsoft это не мешает. В некоторых организациях администратор может запретить сотрудникам давать доступ непроверенным приложениям.
