export const devicePanel = '<a id="devices-link" href="/?devices=1">Devices</a><section id="devices-panel" hidden><h1 id="devices-title"></h1><p id="devices-message" role="status"></p><div id="devices-list"></div><a id="devices-back" href="/">Harness</a></section>';

// Serialized into the existing portal client; no token or signer is rendered.
export function devicePortal({document, api}) {
  const $ = id => document.getElementById(id), cs = document.documentElement.lang === 'cs';
  const label = (czech, english) => cs ? czech : english;
  $('devices-link').textContent = label('Správa zařízení', 'Manage devices');
  $('devices-title').textContent = label('Přístupy zařízení', 'Device access');
  $('devices-back').textContent = label('Zpět k probuzení serveru', 'Back to server wake');
  $('devices-back').href = '/?lang=' + (cs ? 'cs' : 'en');
  let epoch = 0;
  async function load() {
    const version = ++epoch, result = await api('devices/list', {});
    if (version !== epoch) return;
    $('login').hidden = true; $('control').hidden = true; $('devices-panel').hidden = false;
    const list = $('devices-list'); list.replaceChildren();
    if (!result.devices?.length) {list.textContent = label('Žádná propojená zařízení.', 'No paired devices.'); return;}
    for (const row of result.devices) {
      const article = document.createElement('article'); article.style.cssText = 'margin:16px 0;padding:16px;border:1px solid #63728b;border-radius:12px;overflow-wrap:anywhere';
      const heading = document.createElement('h2'); heading.textContent = row.name || row.deviceId.slice(-8); article.append(heading);
      const identity = document.createElement('p'); identity.textContent = 'ID: ' + row.deviceId; article.append(identity);
      const revoked = row.revokedAt !== null, status = document.createElement('p');
      status.textContent = revoked ? label('Přístup zrušen', 'Access revoked') : label('Platí do: ', 'Valid until: ') + new Date(row.expiresAt).toLocaleString(cs ? 'cs-CZ' : 'en-GB'); article.append(status);
      const button = document.createElement('button'), action = revoked ? 'reenroll' : 'revoke';
      button.textContent = revoked ? label('Znovu povolit toto zařízení', 'Allow this device again') : label('Zrušit přístup k probuzení', 'Revoke wake access');
      button.dataset.deviceId = row.deviceId; button.dataset.action = action;
      button.onclick = async () => {
        button.disabled = true;
        try {
          await api('devices/' + action, {deviceId: row.deviceId, ...(revoked ? {confirmDeviceId: row.deviceId} : {})});
          $('devices-message').textContent = revoked ? label('Přístup je znovu povolený. Na daném zařízení potvrďte obnovení.', 'Access is allowed again. Confirm recovery on that device.') : label('Přístup k probuzení byl zrušen.', 'Wake access was revoked.');
          await load();
        } catch { $('devices-message').textContent = label('Změnu se nepodařilo potvrdit. Zkuste to znovu.', 'The change could not be confirmed. Try again.'); }
        finally {button.disabled = false;}
      };
      article.append(button); list.append(article);
    }
  }
  return {load};
}
