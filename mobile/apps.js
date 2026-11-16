'use strict';
(()=>{
 let serial=0;
 const messages={
 "apps.applications_and_containers_54d9ed": {
  "en": "Applications and containers",
  "cs": "Aplikace a kontejnery"
 },
 "apps.build_a_project_deploy_a_preview_and_verify__f124ec": {
  "en": "Build a project, deploy a preview and verify the running application.",
  "cs": "Sestavení projektu, zkušební nasazení a kontroly běžící aplikace."
 },
 "apps.close_ae2883": {
  "en": "Close",
  "cs": "Zavřít"
 },
 "apps.loading_5ee635": {
  "en": "Loading…",
  "cs": "Načítám…"
 },
 "apps.wake_docker_62eb4a": {
  "en": "Wake Docker",
  "cs": "Probudit Docker"
 },
 "apps.sleep_docker_4bd400": {
  "en": "Sleep Docker",
  "cs": "Uspat Docker"
 },
 "apps.keep_awake_for_15_minutes_46326e": {
  "en": "Keep awake for 15 minutes",
  "cs": "Neuspávat 15 minut"
 },
 "apps.allow_sleep_1d2767": {
  "en": "Allow sleep",
  "cs": "Povolit uspání"
 },
 "apps.deployment_settings_cf0c17": {
  "en": "Deployment settings",
  "cs": "Nastavení nasazení"
 },
 "apps.application_and_docker_settings_69b030": {
  "en": "Application and Docker settings",
  "cs": "Nastavení aplikací a Dockeru"
 },
 "apps.enable_previews_over_tailscale_63ef89": {
  "en": "Enable previews over Tailscale",
  "cs": "Povolit náhledy v síti Tailscale"
 },
 "apps.ports_18080_18087_access_follows_the_existin_0d74ad": {
  "en": "Ports 18080–18087. Access follows the existing users, devices and rules of your Tailscale network. Public internet access is not enabled.",
  "cs": "Porty 18080–18087. Přístup mají zařízení a uživatelé povolení současnými pravidly tvé sítě Tailscale. Veřejný internet se neotevírá."
 },
 "apps.save_settings_bcc3f3": {
  "en": "Save settings",
  "cs": "Uložit nastavení"
 },
 "apps.credential_vault_f2ca94": {
  "en": "Credential vault",
  "cs": "Trezor přihlašovacích údajů"
 },
 "apps.infisical_cloud_free_connect_a_machine_ident_ecc64a": {
  "en": "Infisical Cloud Free. Connect a machine identity allowed to read the relevant projects. Passwords stay in the vault; these settings store the connection and references.",
  "cs": "Infisical Cloud Free. Připoj strojovou identitu s přístupem k příslušným projektům. Hesla patří do trezoru; sem ukládáme pouze přístupovou identitu a odkazy."
 },
 "apps.region_b99dda": {
  "en": "Region",
  "cs": "Oblast"
 },
 "apps.europe_882fb0": {
  "en": "Europe",
  "cs": "Evropa"
 },
 "apps.usa_18bc59": {
  "en": "USA",
  "cs": "USA"
 },
 "apps.legacy_cloud_bd75f4": {
  "en": "Legacy cloud",
  "cs": "Původní cloud"
 },
 "apps.client_id_a766cd": {
  "en": "Client ID",
  "cs": "Client ID"
 },
 "apps.client_secret_2c4e1b": {
  "en": "Client Secret",
  "cs": "Client Secret"
 },
 "apps.verify_and_save_connection_e481c4": {
  "en": "Verify and save connection",
  "cs": "Ověřit a uložit připojení"
 },
 "apps.open_infisical_c79b5a": {
  "en": "Open Infisical",
  "cs": "Otevřít Infisical"
 },
 "apps.remote_deployment_8318c6": {
  "en": "Remote deployment",
  "cs": "Vzdálené nasazení"
 },
 "apps.use_your_linux_server_with_docker_and_ssh_ov_ad2876": {
  "en": "Use your Linux server with Docker and SSH over Tailscale. The public host key is pinned and the private key comes from the vault. Applications use ports 18080–18087 on the target Tailscale address.",
  "cs": "Vlastní Linux server s Dockerem a SSH v Tailscale. Připínáme veřejný klíč hostitele; soukromý klíč se načte z trezoru. Aplikace používá porty 18080–18087 na Tailscale adrese cíle."
 },
 "apps.new_project_87c3be": {
  "en": "New project",
  "cs": "Nový projekt"
 },
 "apps.project_folder_in_the_workspace_5debad": {
  "en": "Project folder in the workspace",
  "cs": "Složka projektu v pracovním prostoru"
 },
 "apps.add_project_ae35b7": {
  "en": "Add project",
  "cs": "Přidat projekt"
 },
 "apps.prepare_docker_0e5e2b": {
  "en": "Prepare Docker",
  "cs": "Připravit Docker"
 },
 "apps.detect_node_python_or_net_and_prepare_docker_ae4594": {
  "en": "Detect Node, Python or .NET and prepare Dockerfile and .harness-app.json without overwriting existing files.",
  "cs": "Rozpoznáme Node, Python nebo .NET a vytvoříme Dockerfile a .harness-app.json. Existující soubory se nepřepisují."
 },
 "apps.projects_8abfb4": {
  "en": "Projects",
  "cs": "Projekty"
 },
 "apps.containers_adbec8": {
  "en": "Containers",
  "cs": "Kontejnery"
 },
 "apps.name_7d859b": {
  "en": "Name",
  "cs": "Název"
 },
 "apps.status_1e54d5": {
  "en": "Status",
  "cs": "Stav"
 },
 "apps.internal_port_0cf30d": {
  "en": "Internal port",
  "cs": "Interní port"
 },
 "apps.controls_371302": {
  "en": "Controls",
  "cs": "Ovládání"
 },
 "apps.recent_operations_00cc5b": {
  "en": "Recent operations",
  "cs": "Poslední operace"
 },
 "apps.log_8bf95e": {
  "en": "Log",
  "cs": "Log"
 },
 "apps.http_checks_confirm_availability_application_ad098a": {
  "en": "HTTP checks confirm availability. Application tests are reported separately. This panel manages its own containers; each preview has a separate address.",
  "cs": "HTTP kontrola potvrzuje dostupnost. Aplikační testy jsou označené samostatně. Panel ovládá pouze kontejnery vytvořené touto službou; náhled má samostatnou adresu."
 },
 "apps.queued_660aa4": {
  "en": "Queued",
  "cs": "Ve frontě"
 },
 "apps.running_f9c057": {
  "en": "Running",
  "cs": "Probíhá"
 },
 "apps.completed_54a7f9": {
  "en": "Completed",
  "cs": "Dokončeno"
 },
 "apps.error_de2bfd": {
  "en": "Error",
  "cs": "Chyba"
 },
 "apps.interrupted_0aa047": {
  "en": "Interrupted",
  "cs": "Přerušeno"
 },
 "apps.asleep_c2085c": {
  "en": "Asleep",
  "cs": "Uspaný"
 },
 "apps.created_66e476": {
  "en": "Created",
  "cs": "Vytvořený"
 },
 "apps.stopped_f2c32b": {
  "en": "Stopped",
  "cs": "Zastavený"
 },
 "apps.restarting_ffb9b3": {
  "en": "Restarting",
  "cs": "Restartuje"
 },
 "apps.paused_37e4d5": {
  "en": "Paused",
  "cs": "Pozastavený"
 },
 "apps.exited_5d0151": {
  "en": "Exited",
  "cs": "Ukončený"
 },
 "apps.build_badd27": {
  "en": "Build",
  "cs": "Sestavení"
 },
 "apps.deployment_2398de": {
  "en": "Deployment",
  "cs": "Nasazení"
 },
 "apps.verification_39be78": {
  "en": "Verification",
  "cs": "Kontrola"
 },
 "apps.verification_and_deployment_3e2592": {
  "en": "Verification and deployment",
  "cs": "Ověření a nasazení"
 },
 "apps.release_rollback_504aff": {
  "en": "Release rollback",
  "cs": "Návrat vydání"
 },
 "apps.compose_application_21d93e": {
  "en": "Compose application",
  "cs": "Sestava Compose"
 },
 "apps.docker_wake_e82a1d": {
  "en": "Docker wake",
  "cs": "Probuzení Dockeru"
 },
 "apps.docker_sleep_e15c79": {
  "en": "Docker sleep",
  "cs": "Uspání Dockeru"
 },
 "apps.preview_settings_40fdd9": {
  "en": "Preview settings",
  "cs": "Nastavení náhledů"
 },
 "apps.operation_failed_bf2cba": {
  "en": "Operation failed",
  "cs": "Operace se nezdařila"
 },
 "apps.request_timed_out_5f496d": {
  "en": "Request timed out.",
  "cs": "Požadavek překročil časový limit."
 },
 "apps.target_id_1001cb": {
  "en": "Target ID",
  "cs": "Označení cíle"
 },
 "apps.home_server_6d2a26": {
  "en": "Home server",
  "cs": "Domácí server"
 },
 "apps.ssh_user_424877": {
  "en": "SSH user",
  "cs": "SSH uživatel"
 },
 "apps.public_host_key_ssh_ed25519_d1c9cb": {
  "en": "Public host key (ssh-ed25519 …)",
  "cs": "Veřejný klíč hostitele (ssh-ed25519 …)"
 },
 "apps.infisical_project_id_3a054e": {
  "en": "Infisical project (ID)",
  "cs": "Infisical projekt (ID)"
 },
 "apps.environment_3415aa": {
  "en": "Environment",
  "cs": "Prostředí"
 },
 "apps.vault_folder_22a195": {
  "en": "Vault folder",
  "cs": "Složka v trezoru"
 },
 "apps.private_ssh_key_name_in_the_vault_25d8c6": {
  "en": "Private SSH key name in the vault",
  "cs": "Název soukromého SSH klíče v trezoru"
 },
 "apps.save_target_9ba729": {
  "en": "Save target",
  "cs": "Uložit cíl"
 },
 "apps.use_one_app_name_vault_key_name_entry_per_li_bc76c1": {
  "en": "Use one APP_NAME=VAULT_KEY_NAME entry per line",
  "cs": "Použij jeden řádek NÁZEV_V_APLIKACI=NÁZEV_V_TREZORU"
 },
 "apps.project_credentials_f0ac2b": {
  "en": "Project credentials",
  "cs": "Přihlašovací údaje projektu"
 },
 "apps.enter_key_names_only_values_are_fetched_from_9d9e21": {
  "en": "Enter key names only. Values are fetched from Infisical when needed.",
  "cs": "Zadej pouze názvy klíčů. Jejich hodnoty se načtou z Infisicalu při použití."
 },
 "apps.infisical_project_id_50ab18": {
  "en": "Infisical project (ID)",
  "cs": "Projekt Infisical (ID)"
 },
 "apps.runtime_name_vault_key_name_e69d8a": {
  "en": "Runtime: NAME=VAULT_KEY_NAME",
  "cs": "Za běhu: NÁZEV=NÁZEV_V_TREZORU"
 },
 "apps.build_secret_id_vault_key_name_ae3267": {
  "en": "Build: SECRET_ID=VAULT_KEY_NAME",
  "cs": "Při buildu: ID_SECRETU=NÁZEV_V_TREZORU"
 },
 "apps.save_references_13a488": {
  "en": "Save references",
  "cs": "Uložit odkazy"
 },
 "apps.release_report_8da3ab": {
  "en": "Release report",
  "cs": "Report vydání"
 },
 "apps.verified_b77aed": {
  "en": "Verified",
  "cs": "Ověřeno"
 },
 "apps.failed_9b4531": {
  "en": "Failed",
  "cs": "Neprošlo"
 },
 "apps.no_build_e6a644": {
  "en": "no build",
  "cs": "bez sestavení"
 },
 "apps.active_737e23": {
  "en": " · active",
  "cs": " · aktivní"
 },
 "apps.restore_this_release_59677a": {
  "en": "Restore this release",
  "cs": "Vrátit tuto verzi"
 },
 "apps.no_verified_releases_yet_a2c36a": {
  "en": "No verified releases yet.",
  "cs": "Zatím žádné ověřené vydání."
 },
 "apps.operation_log_9597eb": {
  "en": "Operation log",
  "cs": "Průběh operace"
 },
 "apps.runtime_log_f8a8e7": {
  "en": "Runtime log",
  "cs": "Běhový log"
 },
 "apps.the_log_is_empty_so_far_9cb497": {
  "en": "The log is empty so far.",
  "cs": "Log je zatím prázdný."
 },
 "apps.waking_docker_26386a": {
  "en": "Waking Docker…",
  "cs": "Probouzím Docker…"
 },
 "apps.restoring_containers_f049e7": {
  "en": "Restoring containers…",
  "cs": "Obnovuji kontejnery…"
 },
 "apps.reconnecting_to_docker_5a1dc2": {
  "en": "Reconnecting to Docker…",
  "cs": "Obnovuji připojení k Dockeru…"
 },
 "apps.saving_containers_and_putting_docker_to_slee_edd8c5": {
  "en": "Saving containers and putting Docker to sleep…",
  "cs": "Ukládám kontejnery a uspávám Docker…"
 },
 "apps.docker_is_not_enabled_yet_78cfd8": {
  "en": "Docker is not enabled yet.",
  "cs": "Docker zatím není zapnutý."
 },
 "apps.docker_is_asleep_building_testing_or_opening_e982c4": {
  "en": "Docker is asleep. Building, testing or opening an application wakes it automatically.",
  "cs": "Docker spí. Při sestavení, testu nebo otevření aplikace se automaticky probudí."
 },
 "apps.docker_is_unavailable_2ad119": {
  "en": "Docker is unavailable. ",
  "cs": "Docker není dostupný. "
 },
 "apps.check_the_connection_aabcf8": {
  "en": "Check the connection.",
  "cs": "Zkontroluj připojení."
 },
 "apps.an_application_operation_is_running_2bd37d": {
  "en": "An application operation is running.",
  "cs": "Probíhá operace s aplikací."
 },
 "apps.docker_is_ready_9d8fb6": {
  "en": "Docker is ready.",
  "cs": "Docker je připravený."
 },
 "apps.vault_connected_8a32e2": {
  "en": "Vault connected: ",
  "cs": "Trezor je připojený: "
 },
 "apps.machine_identity_expires_on_f8516b": {
  "en": " · machine identity expires on ",
  "cs": " · přístupová identita platí do "
 },
 "apps.the_vault_is_not_connected_yet_e0a163": {
  "en": "The vault is not connected yet.",
  "cs": "Trezor ještě není připojený."
 },
 "apps.sleep_is_paused_until_953838": {
  "en": "Sleep is paused until ",
  "cs": "Uspání je pozastavené do "
 },
 "apps.builds_tests_and_application_requests_preven_45e4e2": {
  "en": "Builds, tests and application requests prevent sleep. Listing containers does not keep the server awake.",
  "cs": "Build, test a požadavky na aplikaci chrání server před uspáním. Pouhý seznam kontejnerů jej nedrží zapnutý."
 },
 "apps.this_change_needs_review_7936f2": {
  "en": "This change needs review: ",
  "cs": "Změnu je třeba zkontrolovat: "
 },
 "apps.settings_are_being_prepared_385d69": {
  "en": "Settings are being prepared.",
  "cs": "Nastavení se připravuje."
 },
 "apps.tailscale_access_is_enabled_1cce8f": {
  "en": "Tailscale access is enabled.",
  "cs": "Přístup přes Tailscale je zapnutý."
 },
 "apps.tailscale_access_is_disabled_builds_and_inte_800f7d": {
  "en": "Tailscale access is disabled. Builds and internal tests remain available.",
  "cs": "Přístup přes Tailscale je vypnutý. Sestavení a testy uvnitř serveru fungují dál."
 },
 "apps.no_projects_have_been_added_3d3c9c": {
  "en": "No projects have been added.",
  "cs": "Zatím není přidaný žádný projekt."
 },
 "apps.deployed_16eea7": {
  "en": "deployed",
  "cs": "nasazeno"
 },
 "apps.not_deployed_yet_b63aa3": {
  "en": "not deployed yet",
  "cs": "dosud nenasazeno"
 },
 "apps.built_f23683": {
  "en": "built",
  "cs": "sestaveno"
 },
 "apps.not_built_yet_6e14f3": {
  "en": "not built yet",
  "cs": "dosud nesestaveno"
 },
 "apps.port_e15262": {
  "en": " · port ",
  "cs": " · port "
 },
 "apps.verify_and_deploy_2849b3": {
  "en": "Verify and deploy",
  "cs": "Ověřit a nasadit"
 },
 "apps.build_a0f6c4": {
  "en": "Build",
  "cs": "Sestavit"
 },
 "apps.deploy_3c4af7": {
  "en": "Deploy",
  "cs": "Nasadit"
 },
 "apps.test_11af5a": {
  "en": "Test",
  "cs": "Otestovat"
 },
 "apps.export_application_f356c2": {
  "en": "Export application",
  "cs": "Export aplikace"
 },
 "apps.releases_and_rollback_9dec24": {
  "en": "Releases and rollback",
  "cs": "Historie vydání a návrat"
 },
 "apps.deployment_target_de2da3": {
  "en": "Deployment target",
  "cs": "Cíl nasazení"
 },
 "apps.verify_connection_ad8d81": {
  "en": "Verify connection",
  "cs": "Ověřit připojení"
 },
 "apps.verify_and_deploy_remotely_8ea93e": {
  "en": "Verify and deploy remotely",
  "cs": "Ověřit a nasadit vzdáleně"
 },
 "apps.remote_e22ab2": {
  "en": "Remote: ",
  "cs": "Vzdáleně: "
 },
 "apps.open_remote_application_c924ff": {
  "en": "Open remote application",
  "cs": "Otevřít vzdálenou aplikaci"
 },
 "apps.last_verified_state_refreshing_local_docker__5749c5": {
  "en": "Last verified state; refreshing local Docker does not contact the remote server.",
  "cs": "Poslední ověřený stav; obnova seznamu lokálního Dockeru vzdálený server nekontaktuje."
 },
 "apps.open_application_1aa2b7": {
  "en": "Open application",
  "cs": "Otevřít aplikaci"
 },
 "apps.source_version_e54e69": {
  "en": "Source version: ",
  "cs": "Verze zdrojů: "
 },
 "apps.last_http_check_28f9e6": {
  "en": "Last HTTP check: ",
  "cs": "Poslední HTTP kontrola: "
 },
 "apps.passed_9b0ff7": {
  "en": "passed (",
  "cs": "úspěšná ("
 },
 "apps.check_failed_017d4b": {
  "en": "check failed",
  "cs": "kontrola selhala"
 },
 "apps.application_test_passed_2aaece": {
  "en": " · application test passed",
  "cs": " · aplikační test prošel"
 },
 "apps.running_13df22": {
  "en": "Running",
  "cs": "Běží"
 },
 "apps.logs_0a8f97": {
  "en": "Logs",
  "cs": "Logy"
 },
 "apps.stop_74083f": {
  "en": "Stop",
  "cs": "Zastavit"
 },
 "apps.start_7e4cda": {
  "en": "Start",
  "cs": "Spustit"
 },
 "apps.no_managed_containers_27f350": {
  "en": "No managed containers.",
  "cs": "Žádné spravované kontejnery."
 },
 "apps.http_availability_only_fbdc91": {
  "en": " · HTTP availability only",
  "cs": " · pouze dostupnost HTTP"
 },
 "apps.view_log_186b71": {
  "en": "View log",
  "cs": "Zobrazit log"
 },
 "apps.download_bundle_33c9b2": {
  "en": "Download bundle",
  "cs": "Stáhnout balíček"
 },
 "apps.no_operations_yet_75f8ec": {
  "en": "No operations yet.",
  "cs": "Zatím neproběhla žádná operace."
 },
 "apps.application_management_is_unavailable_c57dbf": {
  "en": "Application management is unavailable. ",
  "cs": "Správa aplikací není dostupná. "
 },
 "apps.docker_prepared_184edb": {
  "en": "Docker prepared · ",
  "cs": "Připravený Docker · "
 },
 "apps.vault_connection_verified_and_saved_b92edd": {
  "en": "Vault connection verified and saved.",
  "cs": "Připojení trezoru ověřeno a uloženo."
 },
 "apps.my_project_67ee56": {
  "en": "my-project",
  "cs": "muj-projekt"
 }
};
 Object.assign(messages,{
  'apps.recovery_review':{en:'Deployment needs review',cs:'Nasazení vyžaduje kontrolu'},
  'apps.recovery_help':{en:'The deployment outcome is uncertain. Data is retained. Changes and automatic retries are paused until the recorded release is reviewed. Logs and reports remain available.',cs:'Výsledek nasazení není potvrzený. Data zůstávají zachovaná. Změny a automatické opakování jsou pozastavené do kontroly záznamu nasazení. Logy a zprávy jsou dostupné.'},
  'apps.deployment_promoting':{en:'Switching deployment',cs:'Přepínání nasazení'},
  'apps.deployment_publishing':{en:'Confirming deployment',cs:'Potvrzování nasazení'},
  'apps.deployment_promotable':{en:'Checks passed; waiting to switch',cs:'Kontroly prošly; čeká na přepnutí'},
  'apps.deployment_planned':{en:'Deployment planned',cs:'Nasazení naplánováno'},
  'apps.deployment_prepared':{en:'Isolated environment prepared',cs:'Oddělené prostředí připravené'},
  'apps.deployment_verifying':{en:'Verifying isolated deployment',cs:'Ověřování odděleného nasazení'},
  'apps.deployment_unconfirmed':{en:'Status not confirmed',cs:'Stav není potvrzený'},
  'apps.start_not_published':{en:'Only the currently published generation can be started. Review its release report.',cs:'Spustit lze pouze aktuálně nasazenou generaci. Podrobnosti najdeš ve zprávě nasazení.'},
  'apps.last_completed_deployment':{en:'Last completed deployment: ',cs:'Poslední dokončené nasazení: '}
 });
 const tApps=key=>messages[key]?.[window.HarnessI18n?.language==='cs'?'cs':'en']||key;
 const appsLocale=()=>window.HarnessI18n?.language==='cs'?'cs-CZ':'en-GB';

 // The adapter owns the HTTP contract; this view never infers deletion eligibility.
 function mountCleanup(host,adapter,{signal,blocked=()=>false}={}){
  const strings={en:{title:'Storage cleanup',auto:'Automatically clean up resources of archived chats',autoHelp:'Keeps resources that are running, published, shared or needed for recovery.',refresh:'Refresh resources',containers:'Containers',images:'Images',empty:'No resources to display.',loading:'Loading resources…',unknown:'Unavailable. Resource status has not been verified.',deferred:'Cleanup is deferred while Docker is unavailable.',select:'Select',preview:'Review selection',remove:'Delete selected resources',selected:'selected',estimate:'Estimated space',partial:'Some sizes are unknown. Shared image layers may reduce the space recovered.',unknownSize:'Size unknown',protected:'Protected',eligible:'Eligible for cleanup',unlinked:'Chat/project link unavailable',saving:'Saving preference…',saved:'Preference saved.',failed:'The operation could not be verified. Refresh before trying again.',changed:'The resource state changed. Review the selection again.',working:'Cleanup in progress…',removed:'Removed',skipped:'Skipped',result:'Cleanup result',cancel:'Back to selection',pending:'Result not yet confirmed. Refresh to check the operation.',off:'Resource management is unavailable while Applications are disabled.'},cs:{title:'Úklid úložiště',auto:'Automaticky uklízet zdroje archivovaných chatů',autoHelp:'Zachová běžící, publikované a sdílené zdroje i zdroje potřebné pro obnovu.',refresh:'Obnovit přehled',containers:'Kontejnery',images:'Obrazy',empty:'Žádné zdroje k zobrazení.',loading:'Načítám zdroje…',unknown:'Nedostupné. Stav zdrojů nebyl ověřen.',deferred:'Úklid je odložený, dokud nebude Docker dostupný.',select:'Vybrat',preview:'Zkontrolovat výběr',remove:'Smazat vybrané zdroje',selected:'vybráno',estimate:'Odhad místa',partial:'Některé velikosti nejsou známé. Sdílené vrstvy obrazů mohou uvolněné místo snížit.',unknownSize:'Velikost neznámá',protected:'Chráněno',eligible:'Lze uklidit',unlinked:'Vazba na chat/projekt není dostupná',saving:'Ukládám nastavení…',saved:'Nastavení uloženo.',failed:'Výsledek se nepodařilo ověřit. Před dalším pokusem obnov přehled.',changed:'Stav zdrojů se změnil. Zkontroluj výběr znovu.',working:'Probíhá úklid…',removed:'Odstraněno',skipped:'Přeskočeno',result:'Výsledek úklidu',cancel:'Zpět k výběru',pending:'Výsledek zatím není potvrzený. Obnov přehled pro kontrolu operace.',off:'Správa zdrojů není dostupná, když jsou Aplikace vypnuté.'}};
  const tr=k=>strings[window.HarnessI18n?.language==='cs'?'cs':'en'][k];
  Object.assign(strings.en,{deferred:'Cleanup is deferred while Docker is unavailable.',absent:'Already absent',uncertain:'Unconfirmed',remaining:'Without a result'});
  Object.assign(strings.cs,{deferred:'Úklid je odložený, dokud nebude Docker dostupný.',absent:'Už neexistuje',uncertain:'Nepotvrzeno',remaining:'Bez výsledku'});
  const element=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
  const box=element('section',undefined,'apps-cleanup');box.dataset.appsCleanup='';host.append(box);
  let dead=false,readEpoch=0,revision=0,inventory=null,selected=new Set(),preview=null,operation=null,loading=false,mutating=false,error='',notice='',saveNotice='',saving=false,prefDraft=null,prefRevision=0,preferenceEpoch=0,timer;
  const hintKey='harness.docker-cleanup.pending.v1';
  function readHint(){try{const r=JSON.parse(sessionStorage.getItem(hintKey));if(r&&/^[a-f0-9]{32}$/.test(r.token)&&/^[a-f0-9]{64}$/.test(r.hash)&&(!r.id||/^[a-f0-9]{32}$/.test(r.id))&&Array.isArray(r.items)&&r.items.length>0&&r.items.length<=100&&r.items.every(s=>s&&['container','image'].includes(s.kind)&&(s.kind==='container'?/^[a-f0-9]{64}$/:/^sha256:[a-f0-9]{64}$/).test(s.id))&&new Set(r.items.map(s=>s.kind+':'+s.id)).size===r.items.length)return r;}catch{}return null;}
  let receiptRequest=readHint(),awaitingReceipt=Boolean(receiptRequest);
  function saveHint(){try{sessionStorage.setItem(hintKey,JSON.stringify(receiptRequest));}catch{/* Memory recovery remains available when tab storage is unavailable. */}}
  function clearHint(){try{const saved=readHint();if(saved?.token===receiptRequest?.token&&saved?.hash===receiptRequest?.hash)sessionStorage.removeItem(hintKey);}catch{}}
  const alive=()=>!dead&&!signal?.aborted;
  const key=r=>r.kind+':'+r.id;
  const rows=()=>Array.isArray(inventory?.resources)?inventory.resources:[];
  const ready=()=>inventory?.availability==='ready'&&!blocked()&&!mutating&&!loading&&!awaitingReceipt;
  const canSelect=r=>ready()&&r.eligible===true&&Array.isArray(r.reasons)&&r.reasons.length===0;
  const chosen=()=>rows().filter(r=>selected.has(key(r)));
  function select(r,checked){
   if(!canSelect(r))return;
   if(checked){
    const dependencies=(r.afterContainerIds||[]).map(id=>rows().find(v=>v.kind==='container'&&v.id===id));
    if(dependencies.some(v=>!v||!canSelect(v))||new Set([...selected,key(r),...dependencies.map(key)]).size>100){error=tr('changed');render();return;}
    selected.add(key(r));for(const d of dependencies)selected.add(key(d));
   }else{selected.delete(key(r));if(r.kind==='container')for(const image of rows().filter(v=>v.kind==='image'&&v.afterContainerIds?.includes(r.id)))selected.delete(key(image));}
   invalidate();notice='';render();
  }
  const bytes=n=>Number.isSafeInteger(n)&&n>=0?new Intl.NumberFormat(window.HarnessI18n?.language==='cs'?'cs-CZ':'en-GB',{maximumFractionDigits:1}).format(n/1048576)+' MB':tr('unknownSize');
  function action(label,fn,disabled=false){const b=element('button',label);b.type='button';b.disabled=disabled;b.onclick=()=>void fn();return b;}
  function invalidate(){revision++;preview=null;}
  function render(){
   if(!alive())return;
   const focus=box.contains(document.activeElement)?document.activeElement?.dataset.cleanupFocus:null;
   box.replaceChildren(element('h3',tr('title')));box.setAttribute('aria-busy',String(loading||mutating));
   const pref=element('label',undefined,'apps-cleanup-auto'),input=element('input');input.type='checkbox';input.dataset.cleanupFocus='preference';input.checked=prefDraft??inventory?.autoCleanup??false;input.disabled=typeof inventory?.autoCleanup!=='boolean';input.onchange=()=>{prefDraft=input.checked;prefRevision++;void savePreference();};pref.append(input,element('span',tr('auto')));box.append(pref,element('p',tr('autoHelp'),'apps-note'));
   if(saveNotice){const p=element('p',saveNotice);p.setAttribute('role','status');box.append(p);}
   const refresh=action(tr('refresh'),()=>refreshInventory(),loading||mutating);refresh.dataset.cleanupFocus='refresh';box.append(refresh);
   if(error){const p=element('p',error);p.setAttribute('role','alert');box.append(p);}
   const status=element('p',loading?tr('loading'):mutating?tr('working'):notice||(!inventory?tr('unknown'):inventory.availability==='disabled'?tr('off'):inventory.availability==='deferred'?tr('deferred'):inventory.availability!=='ready'?tr('unknown'):''));status.setAttribute('role','status');status.setAttribute('aria-live','polite');box.append(status);
   for(const kind of ['container','image']){
    const group=element('fieldset'),legend=element('legend',tr(kind==='container'?'containers':'images'));group.append(legend);
    const items=rows().filter(r=>r.kind===kind);
    if(!items.length)group.append(element('p',tr('empty')));
    for(const r of items){
     const card=element('div',undefined,'apps-cleanup-resource'),label=element('label'),check=element('input');check.type='checkbox';check.dataset.cleanupFocus=key(r);check.checked=selected.has(key(r));check.disabled=!canSelect(r);check.setAttribute('aria-label',tr('select')+' '+r.label);check.onchange=()=>select(r,check.checked);label.append(check,element('strong',r.label));card.append(label,element('p',[r.stateLabel,...(r.ownerLabels?.length?r.ownerLabels:[tr('unlinked')])].filter(Boolean).join(' · ')),element('p',bytes(r.sizeBytes)));
     card.append(element('p',r.reasons?.length?r.reasons.join(' · '):r.eligible===true?tr('eligible'):tr('protected'),'apps-note'));if(r.automaticReasons?.length)card.append(element('p',(window.HarnessI18n?.language==='cs'?'Automatický úklid: ':'Automatic cleanup: ')+r.automaticReasons.join(' · '),'apps-note'));group.append(card);
    }box.append(group);
   }
   const items=chosen(),known=items.filter(r=>Number.isSafeInteger(r.sizeBytes)&&r.sizeBytes>=0),total=known.reduce((n,r)=>n+r.sizeBytes,0);
   box.append(element('p',items.length+' '+tr('selected')+' · '+tr('estimate')+': '+(known.length?bytes(total):tr('unknownSize'))),element('p',tr('partial'),'apps-note'));
   if(preview){const review=element('section',undefined,'apps-cleanup-review');review.setAttribute('aria-label',tr('preview'));review.append(element('p',preview.count+' '+tr('selected')+' · '+tr('estimate')+': '+bytes(preview.estimatedBytes)));review.append(action(tr('cancel'),()=>{preview=null;render();},mutating));const remove=action(tr('remove'),removeSelected,!ready()||!items.length||preview.revision!==revision);remove.dataset.cleanupFocus='remove';review.append(remove);box.append(review);}
   else {const b=action(tr('preview'),reviewSelection,!ready()||!items.length);b.dataset.cleanupFocus='preview';box.append(b);}
   if(operation?.result){const result=element('section');result.setAttribute('aria-label',tr('result'));result.setAttribute('role','status');const counts=[['removed',operation.result.removedCount],['skipped',operation.result.skippedCount],['absent',operation.result.absentCount],['uncertain',operation.result.uncertainCount],['remaining',operation.result.remainingCount]].filter(([,n],i)=>i<2||n>0);result.append(element('h4',tr('result')),element('p',counts.map(([label,n])=>tr(label)+': '+n).join(' · ')));for(const s of operation.result.details||[])result.append(element('p',s));box.append(result);}
   if(focus){const target=[...box.querySelectorAll('[data-cleanup-focus]')].find(e=>e.dataset.cleanupFocus===focus);if(target&&!target.disabled)target.focus({preventScroll:true});}
  }
  async function refreshInventory(){
   if(!alive()||mutating)return;
   if(awaitingReceipt){mutating=true;error='';render();await recoverReceipt();return;}
   const epoch=++readEpoch,preferenceToken=prefRevision+':'+preferenceEpoch;loading=true;error='';render();
   try{const next=await adapter.inventory();if(!alive()||epoch!==readEpoch)return;
    if(!next||!Array.isArray(next.resources)||typeof next.autoCleanup!=='boolean')throw Error('INVALID_CLEANUP_STATE');
    if(preferenceToken!==prefRevision+':'+preferenceEpoch&&inventory)next.autoCleanup=inventory.autoCleanup;
    const previous=JSON.stringify(inventory?.resources),previousAvailability=inventory?.availability;inventory=next;
    if(previous!==JSON.stringify(next.resources)||previousAvailability!==next.availability)invalidate();
    // Keep unaffected choices; newly protected/unknown resources are deselected.
    if(next.availability==='ready')selected=new Set(next.resources.filter(r=>r.eligible===true&&Array.isArray(r.reasons)&&!r.reasons.length&&selected.has(key(r))).map(key));
   }catch(e){if(alive()&&epoch===readEpoch){error=tr('failed');inventory=null;invalidate();}}
   finally{if(alive()&&epoch===readEpoch){loading=false;render();}}
  }
  async function savePreference(){
   if(saving||!alive()||prefDraft===null)return;const value=prefDraft,rev=prefRevision;saving=true;saveNotice=tr('saving');render();
   try{const result=await adapter.preference(value);if(!alive())return;if(result.autoCleanup!==value)throw Error('UNCONFIRMED_PREFERENCE');preferenceEpoch++;if(inventory)inventory.autoCleanup=value;if(rev===prefRevision){prefDraft=null;saveNotice=tr('saved');}}
   catch(e){if(alive())saveNotice=tr('failed');}
   finally{saving=false;if(alive()){render();if(rev!==prefRevision&&prefDraft!==null)void savePreference();}}
  }
  async function reviewSelection(){
   if(!ready()||!chosen().length)return;const rev=revision,items=chosen().map(r=>({kind:r.kind,id:r.id}));mutating=true;error='';notice='';render();
   try{const result=await adapter.preview(items);if(!alive())return;if(rev!==revision||!result?.token||result.count!==items.length)throw Error('CHANGED');preview={...result,revision:rev,items};}
   catch(e){if(alive()){preview=null;error=tr('changed');}}
   finally{if(alive()){mutating=false;render();}}
  }
  async function removeSelected(){
   if(!ready()||!preview||preview.revision!==revision)return;
   if(preview.expiresAt<=Date.now()){preview=null;notice=tr('changed');render();return;}
   const reviewed=preview;receiptRequest={token:reviewed.token,hash:reviewed.hash,items:reviewed.items,expiresAt:reviewed.expiresAt};awaitingReceipt=true;saveHint();operation=null;mutating=true;readEpoch++;error='';notice='';preview=null;render();
   try{const next=await adapter.remove(receiptRequest);if(!alive())return;acceptReceipt(next);if(operation.status==='running')await poll();}
   catch(e){if(alive()){error=tr('pending');inventory=null;invalidate();}}
   finally{if(alive()){mutating=operation?.status==='running'&&!error;render();if(['completed','deferred'].includes(operation?.status))void refreshInventory();}}
  }
  function acceptReceipt(next){
   operation=next;receiptRequest={...receiptRequest,id:next.id};awaitingReceipt=['running','uncertain'].includes(next.status);
   if(awaitingReceipt)saveHint();else clearHint();
   if(next.status==='deferred')notice=tr('deferred');
   if(next.status==='uncertain'){error=tr('pending');inventory=null;}
   if(next.status==='completed'){selected.clear();invalidate();}
  }
  async function recoverReceipt(){
   try{const next=receiptRequest.id?await adapter.operation(receiptRequest.id,receiptRequest):await adapter.recover(receiptRequest);if(!alive())return;acceptReceipt(next);if(next.status==='running'){timer=setTimeout(()=>void poll(),1500);return;}mutating=false;render();if(!awaitingReceipt)void refreshInventory();}
   catch(e){if(alive()){mutating=false;error=tr('pending');inventory=null;render();}}
  }
  async function poll(){
   if(!alive()||!['running','uncertain'].includes(operation?.status))return;
   try{const next=await adapter.operation(operation.id,receiptRequest);if(!alive())return;acceptReceipt(next);if(operation.status==='running'){timer=setTimeout(()=>void poll(),1500);return;}mutating=false;render();if(!awaitingReceipt)void refreshInventory();}
   catch(e){if(alive()){mutating=false;error=tr('pending');inventory=null;render();}}
  }
  const language=()=>render();window.addEventListener('harness-language-change',language);signal?.addEventListener('abort',destroy,{once:true});
  function destroy(){dead=true;readEpoch++;clearTimeout(timer);window.removeEventListener('harness-language-change',language);box.remove();}
  let previousBlocked=blocked();
  render();void refreshInventory();return{refresh:refreshInventory,render,updateSafety(){if(previousBlocked!==blocked()){previousBlocked=blocked();render();}},destroy};
 }
 function cleanupAdapter(signal,getState){
  const cs=()=>window.HarnessI18n?.language==='cs';
  const text=value=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,200):'';
  const names=values=>Array.isArray(values)?values.map(text).filter(Boolean):[];
  const reasons={NOT_ARCHIVED:['Chat is not archived','Chat není archivovaný'],SESSION_ACTIVE:['Chat is active','Chat je aktivní'],OWNER_UNKNOWN:['Ownership is not verified','Vlastnictví není ověřené'],OWNER_SHARED:['Shared by multiple chats or projects','Sdíleno více chaty nebo projekty'],OWNERSHIP_CHANGED:['Ownership changed','Vlastnictví se změnilo'],PUBLISHED:['Published application','Publikovaná aplikace'],ROLLBACK_REFERENCE:['Needed for rollback','Potřebné pro návrat verze'],RESUME_REFERENCE:['Needed to resume','Potřebné pro obnovení'],INFLIGHT_REFERENCE:['An operation is using this resource','Zdroj používá probíhající operace'],PERSISTENT_DATA:['Contains persistent data','Obsahuje trvalá data'],CONTAINER_RUNNING:['Container is running','Kontejner běží'],IMAGE_IN_USE:['Image is in use','Obraz se používá'],IMAGE_DESCENDANT:['Another image depends on this image','Na obrazu závisí jiný obraz'],INVENTORY_INCOMPLETE:['Resource inventory is incomplete','Přehled zdrojů není úplný'],REFERENCE_UNKNOWN:['References are not verified','Vazby nejsou ověřené'],DOCKER_ASLEEP:['Docker is asleep','Docker spí'],DOCKER_UNAVAILABLE:['Docker is unavailable','Docker není dostupný'],APPS_BUSY:['Applications are busy','Aplikace právě pracují'],PLAN_STALE:['Review is out of date','Náhled už není aktuální']};
  const reason=code=>reasons[code]?.[cs()?1:0]||(cs()?'Stav vyžaduje kontrolu':'Status needs review');
  async function request(body,selector={}){
   const controller=new AbortController(),abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)controller.abort();
   // Match the backend's bounded mutation/reconciliation RPC deadline. A slower
   // synchronous apply must not turn into an avoidable unknown outcome at 20s.
   const params=new URLSearchParams(Object.entries(selector).filter(([,v])=>v!==undefined));
   const timeout=setTimeout(abort,body?.op==='apply'||params.size?180000:20000);
   try{const response=await fetch('/api/workbench/docker-cleanup'+(params.size?'?'+params:''),{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const value=await response.json();if(!response.ok||value.version!==1)throw Error('CLEANUP_UNVERIFIED');return value;}
   finally{clearTimeout(timeout);signal.removeEventListener('abort',abort);}
  }
  function normalize(value){
   if(typeof value.enabled!=='boolean'||!Array.isArray(value.inventory)||!['ready','deferred','unavailable'].includes(value.availability))throw Error('CLEANUP_UNVERIFIED');
   return{autoCleanup:value.enabled,availability:getState()?.enabled===false?'disabled':value.availability,resources:value.inventory.map((r,index)=>{
    if(!['container','image'].includes(r.kind)||typeof r.id!=='string'||!Array.isArray(r.reasonCodes)||!Array.isArray(r.projectIds)||!Array.isArray(r.sessionIds))throw Error('CLEANUP_UNVERIFIED');
    const state=getState(),projectLabels=names(r.projectNames).length?names(r.projectNames):names(r.projectIds.map(id=>state?.projects?.find(p=>p.id===id)?.name)),chatLabels=names(r.chatNames),container=state?.containers?.find(c=>c.id===r.id),display=text(r.displayName)||names(r.tags)[0]||text(container?.name),label=display&&!/^(?:sha256:)?[a-f0-9]{12,64}$/i.test(display)?display:((r.kind==='container'?(cs()?'Kontejner':'Container'):(cs()?'Obraz':'Image'))+' '+(index+1));
    return{...r,label,ownerLabels:[...projectLabels.map(v=>(cs()?'Projekt: ':'Project: ')+v),...chatLabels.map(v=>(cs()?'Chat: ':'Chat: ')+v),...(r.projectIds.length>projectLabels.length?[(cs()?'Projekty bez názvu: ':'Unnamed projects: ')+(r.projectIds.length-projectLabels.length)]:[]),...(r.sessionIds.length>chatLabels.length?[(cs()?'Chaty bez názvu: ':'Unnamed chats: ')+(r.sessionIds.length-chatLabels.length)]:[])],stateLabel:r.reasonCodes.includes('CONTAINER_RUNNING')?(cs()?'Běží':'Running'):r.eligible?(cs()?'Nepoužívaný zdroj':'Unused resource'):(cs()?'Zachovat':'Keep'),reasons:r.reasonCodes.map(reason),automaticReasons:r.automaticEligible===false?names(r.automaticReasonCodes).map(reason):[]};
   })};
  }
  function operation(value,expected={}){
   const op=value.operation;if(!op||!/^[a-f0-9]{32}$/.test(op.id)||expected.id&&op.id!==expected.id||!Array.isArray(op.results))throw Error('CLEANUP_UNVERIFIED');
   if(!expected.token||op.planId!==expected.token||op.planHash!==expected.hash||!Array.isArray(op.selection)||selectionKey(op.selection)!==selectionKey(expected.items))throw Error('CLEANUP_UNVERIFIED');
   const keys=op.results.map(r=>r.kind+':'+r.id);
   if(new Set(keys).size!==keys.length||op.results.some(r=>!['container','image'].includes(r.kind)||typeof r.id!=='string'||!['removed','already_absent','kept','uncertain'].includes(r.outcome)||expected.items&&!expected.items.some(s=>s.kind===r.kind&&s.id===r.id)))throw Error('CLEANUP_UNVERIFIED');
   const status=op.state==='reconciliation_required'||op.results.some(r=>r.outcome==='uncertain')?'uncertain':({running:'running',deferred:'deferred',completed:'completed'})[op.state];if(!status)throw Error('CLEANUP_UNVERIFIED');
   return{id:op.id,status,items:expected.items,result:{removedCount:op.results.filter(r=>r.outcome==='removed').length,skippedCount:op.results.filter(r=>r.outcome==='kept').length,absentCount:op.results.filter(r=>r.outcome==='already_absent').length,uncertainCount:op.results.filter(r=>r.outcome==='uncertain').length,remainingCount:expected.items?Math.max(0,expected.items.length-op.results.length):null,details:op.results.filter(r=>r.outcome!=='removed').map(r=>r.outcome==='already_absent'?(cs()?'Zdroj už neexistuje.':'Resource is already absent.'):r.outcome==='uncertain'?(cs()?'Výsledek odstranění není potvrzený.':'Deletion outcome is unconfirmed.'):reason(r.reasonCode))}};
  }
  const selectionKey=items=>JSON.stringify(items.map(r=>r.kind+':'+r.id).sort());
  return{
   async inventory(){return normalize(await request());},
   async preference(enabled){const value=await request({op:'settings',enabled});return{autoCleanup:value.enabled};},
   async preview(selections){
    const value=await request({op:'preview',selections}),plan=value.plan;
    if(value.availability!=='ready'||!plan||plan.availability!=='ready'||
      !/^[a-f0-9]{32}$/.test(plan.id)||!/^[a-f0-9]{64}$/.test(plan.hash)||
      !Number.isFinite(plan.expiresAt)||plan.expiresAt<=Date.now()||
      !Array.isArray(plan.selection)||!Array.isArray(plan.rows)||
      selectionKey(plan.selection)!==selectionKey(selections))throw Error('CLEANUP_STALE');
    const selectedRows=selections.map(s=>plan.rows.find(r=>r.kind===s.kind&&r.id===s.id));
    if(selectedRows.some(r=>!r||r.eligible!==true||!Array.isArray(r.reasonCodes)||r.reasonCodes.length))throw Error('CLEANUP_STALE');
    const sizes=selectedRows.map(r=>r.sizeBytes);
    return{token:plan.id,hash:plan.hash,count:plan.selection.length,
     estimatedBytes:sizes.every(n=>Number.isSafeInteger(n)&&n>=0)?sizes.reduce((a,b)=>a+b,0):null,
     expiresAt:plan.expiresAt};
   },
   async remove(plan){
    if(plan.expiresAt<=Date.now())throw Error('CLEANUP_STALE');
    return operation(await request({op:'apply',planId:plan.token,planHash:plan.hash,selections:plan.items}),plan);
   },
   async operation(id,expected){return operation(await request(undefined,{operationId:id,planId:expected.token}),{...expected,id});},
   async recover(expected){return operation(await request(undefined,{planId:expected.token}),expected);}
  };
 }
 window.HarnessApps={mount(host,options={}){
 const embedded=Boolean(host),prefix='aview-'+(++serial)+'-',lifetime=new AbortController();
 const view=Object.freeze({scope:options.scope==='global'?'global':'project',sessionId:options.sessionId||null,workspaceId:options.workspaceId||null});
 let boundProjectId=null,bindingEpoch=0,contextInvalid=false;
 const panel=document.createElement(embedded?'section':'dialog');panel.id=prefix+'root';panel.className='harness-apps';panel.setAttribute('aria-label','Docker');
 panel.innerHTML=`<header class="apps-head"><div><h2 id="apps-title" data-app-copy="apps.applications_and_containers_54d9ed">Aplikace a kontejnery</h2><p data-app-copy="apps.build_a_project_deploy_a_preview_and_verify__f124ec">Sestavení projektu, zkušební nasazení a kontroly běžící aplikace.</p></div><button id="apps-close" data-app-copy="apps.close_ae2883">Zavřít</button></header>
 <p id="apps-connection" role="status" data-app-copy="apps.loading_5ee635">Načítám…</p>
 <div id="apps-power" class="apps-actions"><button id="apps-wake" type="button" disabled="" data-app-copy="apps.wake_docker_62eb4a">Probudit Docker</button><button id="apps-sleep" type="button" disabled="" data-app-copy="apps.sleep_docker_4bd400">Uspat Docker</button><button id="apps-hold" type="button" disabled="" data-app-copy="apps.keep_awake_for_15_minutes_46326e">Neuspávat 15 minut</button><button id="apps-release" type="button" disabled="" data-app-copy="apps.allow_sleep_1d2767">Povolit uspání</button></div><p id="apps-power-note"></p>
 <details id="apps-settings-group"><summary data-app-copy="apps.deployment_settings_cf0c17">Nastavení nasazení</summary><details id="apps-preview-settings"><summary data-app-copy="apps.application_and_docker_settings_69b030">Nastavení aplikací a Dockeru</summary><p id="apps-preview-state"></p><label><input id="apps-preview-enabled" type="checkbox" disabled=""><span data-app-copy="apps.enable_previews_over_tailscale_63ef89">Povolit náhledy v síti Tailscale</span></label><p data-app-copy="apps.ports_18080_18087_access_follows_the_existin_0d74ad">Porty 18080–18087. Přístup mají zařízení a uživatelé povolení současnými pravidly tvé sítě Tailscale. Veřejný internet se neotevírá.</p><button id="apps-preview-save" type="button" disabled="" data-app-copy="apps.save_settings_bcc3f3">Uložit nastavení</button></details>
 <details id="apps-vault"><summary data-app-copy="apps.credential_vault_f2ca94">Trezor přihlašovacích údajů</summary><p id="apps-vault-state"></p><p data-app-copy="apps.infisical_cloud_free_connect_a_machine_ident_ecc64a">Infisical Cloud Free. Připoj strojovou identitu s přístupem k příslušným projektům. Hesla patří do trezoru; sem ukládáme pouze přístupovou identitu a odkazy.</p><form id="apps-vault-form"><label><span data-app-copy="apps.region_b99dda">Oblast</span><select id="apps-vault-origin"><option value="https://eu.infisical.com" data-app-copy="apps.europe_882fb0">Evropa</option><option value="https://us.infisical.com" data-app-copy="apps.usa_18bc59">USA</option><option value="https://app.infisical.com" data-app-copy="apps.legacy_cloud_bd75f4">Původní cloud</option></select></label><label><span data-app-copy="apps.client_id_a766cd">Client ID</span><input id="apps-vault-client" required="" autocomplete="off"></label><label><span data-app-copy="apps.client_secret_2c4e1b">Client Secret</span><input id="apps-vault-secret" type="password" required="" autocomplete="new-password"></label><button type="submit" data-app-copy="apps.verify_and_save_connection_e481c4">Ověřit a uložit připojení</button></form><a href="https://eu.infisical.com" target="_blank" rel="noopener noreferrer" data-app-copy="apps.open_infisical_c79b5a">Otevřít Infisical</a></details>
 <details id="apps-targets"><summary data-app-copy="apps.remote_deployment_8318c6">Vzdálené nasazení</summary><p data-app-copy="apps.use_your_linux_server_with_docker_and_ssh_ov_ad2876">Vlastní Linux server s Dockerem a SSH v Tailscale. Připínáme veřejný klíč hostitele; soukromý klíč se načte z trezoru. Aplikace používá porty 18080–18087 na Tailscale adrese cíle.</p><form id="apps-target-form"></form><div id="apps-target-list"></div></details>
 </details><details id="apps-add-panel" open=""><summary data-app-copy="apps.new_project_87c3be">Nový projekt</summary><form id="apps-add"><label for="apps-path" data-app-copy="apps.project_folder_in_the_workspace_5debad">Složka projektu v pracovním prostoru</label><div><input id="apps-path" placeholder="muj-projekt" data-app-placeholder="apps.my_project_67ee56" required="" maxlength="300" autocomplete="off"><button type="submit" disabled="" data-app-copy="apps.add_project_ae35b7">Přidat projekt</button><button id="apps-package" type="button" data-app-copy="apps.prepare_docker_0e5e2b">Připravit Docker</button></div><small data-app-copy="apps.detect_node_python_or_net_and_prepare_docker_ae4594">Rozpoznáme Node, Python nebo .NET a vytvoříme Dockerfile a .harness-app.json. Existující soubory se nepřepisují.</small></form></details>
 <p id="apps-error" role="alert"></p><section aria-labelledby="apps-projects-title"><h3 id="apps-projects-title" data-app-copy="apps.projects_8abfb4">Projekty</h3><div id="apps-projects"></div></section>
 <section aria-labelledby="apps-containers-title"><h3 id="apps-containers-title" data-app-copy="apps.containers_adbec8">Kontejnery</h3><div class="apps-scroll"><table><thead><tr><th data-app-copy="apps.name_7d859b">Název</th><th data-app-copy="apps.status_1e54d5">Stav</th><th data-app-copy="apps.internal_port_0cf30d">Interní port</th><th data-app-copy="apps.controls_371302">Ovládání</th></tr></thead><tbody id="apps-containers"></tbody></table></div></section>
 <section aria-labelledby="apps-jobs-title"><h3 id="apps-jobs-title" data-app-copy="apps.recent_operations_00cc5b">Poslední operace</h3><div id="apps-jobs"></div></section><section id="apps-log-panel" hidden=""><h3 id="apps-log-title" data-app-copy="apps.log_8bf95e">Log</h3><pre id="apps-log" tabindex="0"></pre></section>
 <p class="apps-note" data-app-copy="apps.http_checks_confirm_availability_application_ad098a">HTTP kontrola potvrzuje dostupnost. Aplikační testy jsou označené samostatně. Panel ovládá pouze kontejnery vytvořené touto službou; náhled má samostatnou adresu.</p>`;
 const style=document.createElement('style');style.textContent=`
 #harness-apps{position:fixed;inset:0;width:100%;height:100dvh;max-width:none;max-height:none;margin:0;border:0;padding:24px max(18px,calc((100vw - 1120px)/2));padding-top:calc(20px + env(safe-area-inset-top));background:#f6f9fc;color:#172a32;font:15px system-ui;overflow:auto}
 #harness-apps,#harness-apps *{box-sizing:border-box}#harness-apps::backdrop{background:#172a3255}#harness-apps .apps-head{display:flex;justify-content:space-between;align-items:start;gap:16px;padding:0;background:none;border:0}#harness-apps h2{margin:0;font-size:26px}#harness-apps h3{margin:24px 0 12px}#harness-apps p,#harness-apps small{line-height:1.5}#harness-apps .apps-head p,#harness-apps .apps-note,#harness-apps small,#apps-power-note{color:#64777e;font-size:13px}
 #harness-apps button{font:inherit;min-height:40px;white-space:nowrap;border:1px solid #c5cfdf;border-radius:9px;background:white;padding:8px 12px;color:#17243b;cursor:pointer}#harness-apps button:disabled{opacity:.5;cursor:default}#harness-apps button:focus-visible,#harness-apps input:focus-visible,#harness-apps a:focus-visible,#harness-apps summary:focus-visible{outline:3px solid #235dd7;outline-offset:3px}#harness-apps a{color:#235dd7}#apps-close{flex:none}
 #apps-add,#apps-preview-settings{margin-top:20px;padding:18px;background:white;border:1px solid #dce5e9;border-radius:12px}#apps-add label,#apps-preview-settings summary{font-weight:600}#apps-preview-settings summary{cursor:pointer}#apps-preview-settings p{font-size:13px;color:#64777e}#apps-preview-enabled{width:18px;height:18px;vertical-align:middle;margin:0 8px 0 0}#apps-add>div{display:flex;gap:10px;margin:10px 0}#apps-path{flex:1;min-width:0;max-width:none;letter-spacing:0;font:inherit;padding:10px;border:1px solid #aebbd1;border-radius:8px}#apps-error{color:#a52222;white-space:pre-wrap}
 #harness-apps .apps-project{background:white;border:1px solid #dce5e9;border-radius:12px;padding:18px;margin:12px 0}#harness-apps .apps-project h4{font-size:17px;margin:0 0 6px}#harness-apps .apps-project p{font-size:13px;color:#64777e;overflow-wrap:anywhere}#harness-apps .apps-actions{display:flex;gap:8px;flex-wrap:wrap}#harness-apps .apps-actions a{padding:10px 4px}#harness-apps .apps-project .apps-actions button:first-child{background:#235dd7;color:white;border-color:#235dd7}
 #harness-apps .apps-scroll{overflow:auto}#harness-apps table{width:100%;border-collapse:collapse;background:white;font-size:13px}#harness-apps th,#harness-apps td{text-align:left;border-bottom:1px solid #dce5e9;padding:12px;white-space:nowrap}#harness-apps td button{font-size:12px;margin-right:6px}#apps-log{background:#12202c;color:#deedf4;padding:18px;border-radius:10px;max-height:45vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 ui-monospace,monospace}#harness-apps .apps-job{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid #dce5e9;padding:10px 0;font-size:13px}#apps-connection{padding:12px 16px;background:white;border-left:4px solid #168b72;border-radius:6px}
 @media(max-width:550px){#harness-apps .apps-head h2{font-size:22px}#apps-add>div{flex-direction:column}#harness-apps .apps-actions button{flex:1}#harness-apps .apps-job{align-items:start}#harness-apps th,#harness-apps td{padding:9px}}
 `;
 panel.innerHTML=panel.innerHTML.replace(/(id|for|aria-labelledby)="([^"]+)"/g,(_,attr,id)=>attr+'="'+prefix+id+'"');
 style.textContent=style.textContent.replace(/#harness-apps/g,'#'+prefix+'root').replace(/#apps-([\w-]+)/g,'#'+prefix+'apps-$1');
 if(embedded){panel.open=true;host.append(style,panel);}else{document.head.appendChild(style);document.body.appendChild(panel);}
 const el=id=>panel.querySelector('#'+prefix+id);
 style.textContent+='#'+panel.id+' [hidden]{display:none!important}';
 const contextBox=document.createElement('section'),contextTitle=document.createElement('p'),contextDetail=document.createElement('p'),contextActions=document.createElement('div'),rebind=document.createElement('button'),admin=document.createElement('button'),prepare=document.createElement('button'),allApps=document.createElement('button');
 contextBox.className='apps-context';contextBox.dataset.appsContext=view.scope;contextDetail.style.cssText='font-size:12px;overflow-wrap:anywhere';contextTitle.setAttribute('role','status');contextActions.className='apps-actions';
 for(const control of [rebind,admin,prepare,allApps])control.type='button';contextActions.append(prepare,rebind,admin,allApps);contextBox.append(contextTitle,contextDetail,contextActions);el('apps-connection').after(contextBox);
 style.textContent+=`#apps-settings-group,#apps-add-panel,#apps-vault,#apps-targets{margin:20px 0;padding:18px;border:1px solid #dce5e9;border-radius:12px;background:white}#harness-apps details summary{cursor:pointer;font-weight:600}#harness-apps form:not(#apps-add),#harness-apps .apps-project details{margin:14px 0}#harness-apps label:has(input:not([type=checkbox])),#harness-apps label:has(textarea),#harness-apps label:has(select){display:block;font-size:13px;margin:10px 0}#harness-apps input:not([type=checkbox]),#harness-apps textarea,#harness-apps select{display:block;width:100%;min-width:0;font:inherit;padding:9px;border:1px solid #aebbd1;border-radius:7px;margin-top:5px}#harness-apps textarea{min-height:72px;resize:vertical}#apps-add>div{flex-wrap:wrap}#harness-apps .apps-actions select{width:auto;max-width:100%;margin:0}#harness-apps .apps-job{flex-wrap:wrap}#apps-vault form,#apps-target-form{max-width:620px}#apps-add-panel #apps-add{border:0;padding:0;margin:0;background:none}`;
 style.textContent=style.textContent.replace(/#harness-apps/g,'#'+prefix+'root').replace(/#apps-([\w-]+)/g,'#'+prefix+'apps-$1');
 if(embedded){style.textContent+='#'+prefix+'root{position:relative;inset:auto;width:100%;height:100%;min-height:200px;padding:16px;overflow:auto}#'+prefix+'root>.apps-head{display:none}';if(options.settings){for(const child of panel.children)child.hidden=child!==el('apps-settings-group')&&child!==el('apps-error')&&child!==el('apps-connection');el('apps-settings-group').open=true;}else{el('apps-settings-group').hidden=true;}}
 if(embedded)style.textContent+='#'+prefix+'root{container-type:inline-size}#'+prefix+'root button{white-space:normal}@container(max-width:600px){#'+prefix+'root table,#'+prefix+'root tbody{display:block;width:100%}#'+prefix+'root thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}#'+prefix+'root tr{display:flex;flex-wrap:wrap;border:1px solid #dce5e9;border-radius:9px;margin:10px 0;padding:10px}#'+prefix+'root td{display:block;white-space:normal;border:0;padding:4px;overflow-wrap:anywhere}#'+prefix+'root td:first-child{font-weight:600;width:100%}#'+prefix+'root td:last-child{display:flex;flex-wrap:wrap;gap:6px;width:100%}#'+prefix+'root .apps-actions{flex-direction:column}#'+prefix+'root .apps-actions>*{max-width:100%;width:100%}#'+prefix+'apps-add>div{flex-direction:column}}';
 if(window.HarnessNativeTheme){panel.classList.add('harness-native-surface');style.textContent=window.HarnessNativeTheme.css(style.textContent,panel.id);}
 let loading=false,acting=false,state=null,selectedLog=null,restoreFocus=null,renderedKey='',connectionText='',addPanelInitialized=false,cleanup=null,resources=null;
 const recoveryBox=node('section',undefined,'apps-context');recoveryBox.dataset.appsRecovery='';recoveryBox.setAttribute('role','status');recoveryBox.setAttribute('aria-live','polite');recoveryBox.hidden=true;const recoveryTitle=node('strong'),recoveryHelp=node('p');recoveryBox.append(recoveryTitle,recoveryHelp);contextBox.after(recoveryBox);
 const recoveryRequired=()=>state?.deploymentRecovery?.version===1&&state.deploymentRecovery.required===true;
 const canStart=id=>{const c=state?.containers.find(c=>c.id===id);return c?.canStart===true&&!['data-helper','test'].includes(c.role);};
 function mutationButton(text,handler,disabled=false){const b=button(text,handler,disabled);b.dataset.appMutation='';b.dataset.appBaseDisabled=String(disabled);return b;}
 function mutationControl(control,disabled){control.dataset.appMutation='';control.dataset.appBaseDisabled=String(disabled);control.disabled=disabled||recoveryRequired();}
 function applySafety(){const blocked=recoveryRequired(),busy=!!state?.busy||state?.worker?.phase==='saving';recoveryBox.hidden=!blocked;recoveryTitle.textContent=tApps('apps.recovery_review');recoveryHelp.textContent=tApps('apps.recovery_help');for(const b of panel.querySelectorAll('[data-app-mutation]')){const startBlocked=b.dataset.appStartId!==undefined&&!canStart(b.dataset.appStartId);b.disabled=blocked||acting||contextInvalid||busy||b.dataset.appBaseDisabled==='true'||startBlocked;if(startBlocked)b.title=tApps('apps.start_not_published');else b.title=blocked?tApps('apps.recovery_help'):'';}for(const link of panel.querySelectorAll('[data-app-export]')){link.setAttribute('aria-disabled',String(blocked));if(blocked){link.removeAttribute('href');link.tabIndex=-1;}else{link.href=link.dataset.appExport;link.removeAttribute('tabindex');}link.title=blocked?tApps('apps.recovery_help'):'';link.style.opacity=blocked?'.5':'';link.style.cursor=blocked?'default':'';}}
 const credentialEditors=new Map(),requests=new Set();let stateEpoch=0,refreshAfterMutation=false;
 const alive=()=>!lifetime.signal.aborted&&panel.open;
 const cancelled=()=>new DOMException('Panel request cancelled.','AbortError');
 const contextCopy={en:{project:'Current project',global:'Global application administration',select:'Open a conversation to manage its project.',mismatch:'The project binding changed. Reconnect before making changes.',reconnect:'Reconnect project',admin:'Global deployment settings',prepare:'Prepare Docker for this project',confirm:'This changes global application administration. Continue?'},cs:{project:'Aktuální projekt',global:'Globální správa aplikací',select:'Pro správu projektu otevři konverzaci.',mismatch:'Vazba projektu se změnila. Před úpravami se znovu připoj.',reconnect:'Znovu připojit projekt',admin:'Globální nastavení nasazení',prepare:'Připravit Docker pro tento projekt',confirm:'Tímto měníš globální správu aplikací. Pokračovat?'}},ct=key=>contextCopy[window.HarnessI18n?.language==='cs'?'cs':'en'][key];
 contextCopy.en.manage='Manage all applications';contextCopy.cs.manage='Spravovat všechny aplikace';
 function contextURL(route){const url=new URL('/phone/api/apps/'+route,location.origin);if(view.scope==='global')url.searchParams.set('scope','global');else if(view.sessionId)url.searchParams.set('sessionId',view.sessionId);return url.pathname+url.search;}
 function renderContext(){
  contextBox.hidden=false;
  const title=ct(view.scope==='global'?'global':'project')+(view.scope==='project'&&state?.projects[0]?' · '+state.projects[0].name:'');
  if(contextTitle.textContent!==title)contextTitle.textContent=title;
  contextDetail.textContent=contextInvalid?ct('mismatch'):view.scope==='project'&&!view.sessionId?ct('select'):view.scope==='project'?[state?.context?.workspaceId||view.workspaceId,view.sessionId,boundProjectId].filter(Boolean).join(' · '):'';
  rebind.textContent=ct('reconnect');admin.textContent=ct('admin');prepare.textContent=ct('prepare');allApps.textContent=ct('manage');
  allApps.hidden=view.scope!=='global'||!options.settings;rebind.hidden=!contextInvalid;admin.hidden=view.scope==='global';prepare.hidden=view.scope==='global';prepare.disabled=!view.sessionId||contextInvalid||acting||!state||recoveryRequired();
 }
 const showError=(id,error)=>{if(alive()&&error?.name!=='AbortError')el(id).textContent=error.message;};
 const cancelRequests=()=>{for(const controller of requests)controller.abort();};
 const status=()=>({queued:tApps("apps.queued_660aa4"),running:tApps("apps.running_f9c057"),passed:tApps("apps.completed_54a7f9"),failed:tApps("apps.error_de2bfd"),recovery_required:tApps('apps.recovery_review'),publishing:tApps('apps.deployment_publishing'),promoting:tApps('apps.deployment_promoting'),promotable:tApps('apps.deployment_promotable'),planned:tApps('apps.deployment_planned'),prepared:tApps('apps.deployment_prepared'),verifying:tApps('apps.deployment_verifying'),checking:tApps('apps.deployment_verifying'),interrupted:tApps("apps.interrupted_0aa047"),sleeping:tApps("apps.asleep_c2085c"),created:tApps("apps.created_66e476"),exited:tApps("apps.stopped_f2c32b"),restarting:tApps("apps.restarting_ffb9b3"),paused:tApps("apps.paused_37e4d5"),dead:tApps("apps.exited_5d0151")});
 const actionNames=()=>({build:tApps("apps.build_badd27"),deploy:tApps("apps.deployment_2398de"),check:tApps("apps.verification_39be78"),verify:tApps("apps.verification_and_deployment_3e2592"),rollback:tApps("apps.release_rollback_504aff"),export:'Export',compose:tApps("apps.compose_application_21d93e"),wake:tApps("apps.docker_wake_e82a1d"),sleep:tApps("apps.docker_sleep_e15c79"),'preview-settings':tApps("apps.preview_settings_40fdd9")});
 function node(tag,text,className){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;}
 function lnode(tag,key,className){const element=node(tag,tApps(key),className);element.dataset.appCopy=key;return element;}
 function applyCopy(){for(const element of panel.querySelectorAll('[data-app-copy]'))element.textContent=tApps(element.dataset.appCopy);for(const element of panel.querySelectorAll('[data-app-placeholder]'))element.placeholder=tApps(element.dataset.appPlaceholder);}
 async function api(route,data){
  if(!alive())throw cancelled();
  if(contextInvalid&&route!=='state')throw Error(ct('mismatch'));
  if(view.scope==='project'&&!view.sessionId)throw Error(ct('select'));
  const capturedBinding=bindingEpoch,payload=data?{...data,...(view.scope==='project'?{sessionId:view.sessionId,...(view.workspaceId?{workspaceId:view.workspaceId}:{})}:{})}:undefined;
  const controller=new AbortController(),onAbort=()=>controller.abort();let timedOut=false;
  requests.add(controller);lifetime.signal.addEventListener('abort',onAbort,{once:true});
  const timeout=setTimeout(()=>{timedOut=true;controller.abort();},20000);
  try{
   const r=await fetch(contextURL(route),{method:data?'POST':'GET',cache:'no-store',credentials:'same-origin',signal:controller.signal,headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(payload):undefined});
   const value=await r.json();
   // Some transports may finish despite cancellation: never publish late data.
   if(controller.signal.aborted||!alive()||capturedBinding!==bindingEpoch)throw cancelled();
   if(!r.ok)throw Error(value.error||tApps("apps.operation_failed_bf2cba"));
   const context=value.context;
   if(!context||context.scope!==view.scope||view.scope==='project'&&(context.sessionId!==view.sessionId||view.workspaceId&&context.workspaceId!==view.workspaceId||!/^[a-f0-9]{16}$/.test(context.projectId)||boundProjectId&&boundProjectId!==context.projectId)){
    contextInvalid=true;if(state)render();renderContext();throw Error(ct('mismatch'));
   }
   if(view.scope==='project')boundProjectId=context.projectId;return value;
  }catch(error){if(timedOut&&alive())throw Error(tApps("apps.request_timed_out_5f496d"));throw error;}
  finally{clearTimeout(timeout);requests.delete(controller);lifetime.signal.removeEventListener('abort',onAbort);}
 }
 async function act(route,data,{onSuccess}={}){if(acting||!alive()||contextInvalid)return;if(recoveryRequired()){el('apps-error').textContent=tApps('apps.recovery_help');applySafety();return;}if(route==='container-action'&&data.action==='start'&&!canStart(data.id)){el('apps-error').textContent=tApps('apps.start_not_published');applySafety();return;}if(view.scope==='global'&&!confirm(ct('confirm')))return;acting=true;renderContext();applySafety();el('apps-error').textContent='';try{const result=await api(route,{...data,...(view.scope==='global'?{confirmGlobal:true}:{})});stateEpoch++;onSuccess?.(result);if(result.id&&['project-action','worker-action','preview-settings'].includes(route))selectedLog={type:'job',id:result.id};await refresh({afterMutation:true});if(!alive())return;if(route==='register')el('apps-add-panel').open=false;return result;}catch(e){showError('apps-error',e);}finally{acting=false;if(alive()){renderContext();applySafety();}}}
 function field(label,value='',type='text'){const row=node('label'),caption=lnode('span',label),input=node(type==='textarea'?'textarea':'input');if(type!=='textarea')input.type=type;input.value=value;input.autocomplete='off';row.append(caption,input);return{row,input};}
 const targetFields=[field("apps.target_id_1001cb",'home'),field("apps.name_7d859b",tApps("apps.home_server_6d2a26")),field('Tailscale IP',''),field("apps.ssh_user_424877",''),field('SSH port','22','number'),field("apps.public_host_key_ssh_ed25519_d1c9cb",''),field("apps.infisical_project_id_3a054e",''),field("apps.environment_3415aa",'prod'),field("apps.vault_folder_22a195",'/'),field("apps.private_ssh_key_name_in_the_vault_25d8c6",'DEPLOY_SSH_KEY')];for(const f of targetFields)el('apps-target-form').append(f.row);const targetSubmit=lnode('button',"apps.save_target_9ba729");targetSubmit.type='submit';el('apps-target-form').append(targetSubmit);
 function parseMap(text){const out={};for(const line of text.split('\n').filter(v=>v.trim())){const pair=line.split('=');if(pair.length!==2)throw Error(tApps("apps.use_one_app_name_vault_key_name_entry_per_li_bc76c1"));out[pair[0].trim()]=pair[1].trim();}return out;}
 function credentialForm(p,disabled){
  let editor=credentialEditors.get(p.id);if(!editor){editor={values:null,open:false,revision:0};credentialEditors.set(p.id,editor);}
  const d=node('details'),summary=lnode('summary',"apps.project_credentials_f0ac2b");d.dataset.appsCredentials=p.id;d.open=editor.open;
  d.addEventListener('toggle',()=>{if(alive()&&d.isConnected)editor.open=d.open;});
  d.append(summary,lnode('p',"apps.enter_key_names_only_values_are_fetched_from_9d9e21"));
  const c=p.credentials||{},scope=c.scope||{},values=editor.values||[scope.projectId||'',scope.environment||'prod',scope.secretPath||'/',Object.entries(c.runtime||{}).map(x=>x.join('=')).join('\n'),Object.entries(c.build||{}).map(x=>x.join('=')).join('\n')];
  const fields=[field("apps.infisical_project_id_50ab18",values[0]),field("apps.environment_3415aa",values[1]),field("apps.vault_folder_22a195",values[2]),field("apps.runtime_name_vault_key_name_e69d8a",values[3],'textarea'),field("apps.build_secret_id_vault_key_name_ae3267",values[4],'textarea')];
  for(const f of fields){f.input.addEventListener('input',()=>{editor.values=fields.map(field=>field.input.value);editor.revision++;});d.append(f.row);}
  d.append(mutationButton(tApps("apps.save_references_13a488"),async()=>{
   if(acting||!alive())return;
   try{
    const revision=editor.revision,data={id:p.id,scope:{projectId:fields[0].input.value.trim(),environment:fields[1].input.value.trim(),secretPath:fields[2].input.value.trim()},runtime:parseMap(fields[3].input.value),build:parseMap(fields[4].input.value)};
    await act('project-settings',data,{onSuccess:()=>{
     // Edits made while the save was pending belong to a newer draft.
     if(editor.revision===revision)editor.values=null;
     const current=state?.projects.find(project=>project.id===p.id);if(current)current.credentials={scope:data.scope,runtime:data.runtime,build:data.build};
     renderedKey='';
    }});
   }catch(e){showError('apps-error',e);}
  },disabled));return d;
 }
 async function showReleaseDetail(id,releaseId){try{const data=await api('release?id='+encodeURIComponent(id)+'&releaseId='+encodeURIComponent(releaseId));selectedLog=null;el('apps-log-panel').hidden=false;el('apps-log-title').textContent=tApps("apps.release_report_8da3ab");el('apps-log').textContent=JSON.stringify(data.release,null,2);el('apps-log-panel').scrollIntoView({block:'nearest'});}catch(e){showError('apps-error',e);}}
 async function showReleases(p,host){try{const data=await api('releases?id='+p.id);host.replaceChildren();for(const r of data.releases){const row=node('div',undefined,'apps-job'),description=node('span',new Date(r.startedAt).toLocaleString(appsLocale())+' · '+(r.status==='passed'?tApps("apps.verified_b77aed"):status()[r.status]||tApps('apps.deployment_unconfirmed'))+' · '+(r.source?.sha256?.slice(0,12)||tApps("apps.no_build_e6a644"))+(p.releaseId===r.id?tApps("apps.active_737e23"):''));row.append(description,button('Report',()=>showReleaseDetail(p.id,r.id)),mutationButton(tApps("apps.restore_this_release_59677a"),()=>act('project-action',{id:p.id,action:'rollback',releaseId:r.id}),!!state.busy||r.status!=='passed'||p.releaseId===r.id));host.append(row);}applySafety();if(!data.releases.length)host.append(lnode('p',"apps.no_verified_releases_yet_a2c36a"));}catch(e){showError('apps-error',e);}}
 function button(text,handler,disabled=false){const b=node('button',text);b.type='button';b.disabled=disabled;b.onclick=handler;return b;}
 async function showLog(type,id){if(!alive())return;selectedLog={type,id};await refreshLog();if(alive())el('apps-log-panel').scrollIntoView({block:'nearest'});}
 async function refreshLog(){if(!selectedLog)return;try{const data=await api((selectedLog.type==='job'?'job-log':'container-log')+'?id='+encodeURIComponent(selectedLog.id));el('apps-log-panel').hidden=false;el('apps-log-title').textContent=selectedLog.type==='job'?tApps("apps.operation_log_9597eb"):tApps("apps.runtime_log_f8a8e7");el('apps-log').textContent=data.text||tApps("apps.the_log_is_empty_so_far_9cb497");}catch(e){showError('apps-log',e);}}
 function setConnectionText(text){if(alive()&&connectionText!==text){connectionText=text;el('apps-connection').textContent=text;}}
 function renderConnection(){
  if(recoveryRequired()){setConnectionText(tApps('apps.recovery_review'));return;}
  const phase=state.worker?.phase,managed=state.worker?.managed,busy=!!state.busy||phase==='saving';
  const phases={starting:tApps("apps.waking_docker_26386a"),restoring:tApps("apps.restoring_containers_f049e7"),recovering:tApps("apps.reconnecting_to_docker_5a1dc2"),saving:tApps("apps.saving_containers_and_putting_docker_to_slee_edd8c5")};
  setConnectionText(!state.enabled?tApps("apps.docker_is_not_enabled_yet_78cfd8"):managed&&phase==='asleep'?tApps("apps.docker_is_asleep_building_testing_or_opening_e982c4"):phases[phase]||(!state.available?tApps("apps.docker_is_unavailable_2ad119")+(state.error||state.worker?.error||tApps("apps.check_the_connection_aabcf8")):busy?tApps("apps.an_application_operation_is_running_2bd37d"):tApps("apps.docker_is_ready_9d8fb6")));
 }
 function render(){
  if(!alive())return;
  const phase=state.worker?.phase,managed=state.worker?.managed,busy=!!state.busy||phase==='saving'||contextInvalid;if(!addPanelInitialized){el('apps-add-panel').open=!embedded&&!state.projects.length;addPanelInitialized=true;}if(view.scope==='project')el('apps-add-panel').hidden=true;
  const unavailable=!state.enabled||!state.available&&!managed,held=state.holdUntil>Date.now();
  el('apps-vault-state').textContent=state.vault?.configured?tApps("apps.vault_connected_8a32e2")+state.vault.origin+(state.vault.expiresAt?tApps("apps.machine_identity_expires_on_f8516b")+new Date(state.vault.expiresAt).toLocaleDateString(appsLocale()):''):tApps("apps.the_vault_is_not_connected_yet_e0a163");
  if(!el('apps-vault-form').contains(document.activeElement)){if(!el('apps-vault-client').value)el('apps-vault-client').value=state.vault?.clientId||'';if(state.vault?.origin)el('apps-vault-origin').value=state.vault.origin;}
  el('apps-target-list').replaceChildren(...(state.remoteTargets||[]).map(t=>node('p',t.name+' · '+t.user+'@'+t.host+':'+t.port)));
  renderConnection();
  el('apps-power').hidden=view.scope!=='global'||!state.enabled;mutationControl(el('apps-wake'),busy||!managed||['ready','starting','restoring','recovering'].includes(phase));mutationControl(el('apps-sleep'),busy||!managed||phase!=='ready'||held);mutationControl(el('apps-hold'),busy);el('apps-release').hidden=!held;mutationControl(el('apps-release'),busy);
  el('apps-power-note').textContent=held?tApps("apps.sleep_is_paused_until_953838")+new Date(state.holdUntil).toLocaleTimeString(appsLocale())+'.':tApps("apps.builds_tests_and_application_requests_preven_45e4e2");
  const settings=state.previewSettings;el('apps-preview-enabled').checked=!!settings?.enabled;mutationControl(el('apps-preview-enabled'),busy||!settings?.configured);mutationControl(el('apps-preview-save'),busy||!settings?.configured);el('apps-preview-state').textContent=settings?.error?tApps("apps.this_change_needs_review_7936f2")+settings.error:!settings?.configured?tApps("apps.settings_are_being_prepared_385d69"):settings.enabled?tApps("apps.tailscale_access_is_enabled_1cce8f"):tApps("apps.tailscale_access_is_disabled_builds_and_inte_800f7d");
  mutationControl(el('apps-add').querySelector('button'),unavailable||busy);mutationControl(el('apps-package'),unavailable||busy);mutationControl(el('apps-vault-form').querySelector('button'),busy);mutationControl(targetSubmit,busy);
  const projects=el('apps-projects');for(const details of projects.querySelectorAll('[data-apps-credentials]')){const editor=credentialEditors.get(details.dataset.appsCredentials);if(editor)editor.open=details.open;}projects.replaceChildren();if(!state.projects.length)projects.append(lnode('p',"apps.no_projects_have_been_added_3d3c9c"));
  for(const p of state.projects){
   const language=window.HarnessI18n?.language||'cs',when=p.composeFile?p.deployedAt:p.builtAt,label=p.composeFile?(when?tApps("apps.deployed_16eea7"):tApps("apps.not_deployed_yet_b63aa3")):(when?tApps("apps.built_f23683"):tApps("apps.not_built_yet_6e14f3")),translated=label;
   const card=node('article',undefined,'apps-project');card.append(node('h4',p.name),node('p',p.path+tApps("apps.port_e15262")+p.port+' · '+(recoveryRequired()?tApps('apps.last_completed_deployment'):'')+translated+(when?' '+new Date(when).toLocaleString(language==='cs'?'cs-CZ':'en-GB'):'')));
   const actions=node('div',undefined,'apps-actions');for(const [action,label]of [['verify',tApps("apps.verify_and_deploy_2849b3")],['build',tApps("apps.build_a0f6c4")],['deploy',tApps("apps.deploy_3c4af7")],['check',tApps("apps.test_11af5a")],['export',tApps("apps.export_application_f356c2")]])actions.append(mutationButton(label,()=>act('project-action',{id:p.id,action}),unavailable||busy||!!p.composeFile&&['build','deploy','check'].includes(action)||action==='deploy'&&!p.imageId||action==='check'&&!p.containerId||action==='export'&&!p.releaseId));
   const history=node('details'),releaseRows=node('div');history.append(lnode('summary',"apps.releases_and_rollback_9dec24"),releaseRows);history.ontoggle=()=>{if(history.open)void showReleases(p,releaseRows);};card.append(credentialForm(p,busy||!state.vault?.configured),history);
   if(state.remoteTargets?.length){const remote=node('div',undefined,'apps-actions'),choose=node('select');choose.setAttribute('aria-label',tApps("apps.deployment_target_de2da3"));for(const t of state.remoteTargets){const o=node('option',t.name);o.value=t.id;choose.append(o);}remote.append(choose,mutationButton(tApps("apps.verify_connection_ad8d81"),()=>act('project-action',{id:p.id,action:'remote-preflight',targetId:choose.value}),busy),mutationButton(tApps("apps.verify_and_deploy_remotely_8ea93e"),()=>act('project-action',{id:p.id,action:'remote-verify',targetId:choose.value}),busy));card.append(remote);}
   for(const deployment of Object.values(p.remoteDeployments||{})){const remote=node('details');remote.append(node('summary',tApps("apps.remote_e22ab2")+deployment.name+' · '+new Date(deployment.at).toLocaleString(appsLocale())));const a=lnode('a',"apps.open_remote_application_c924ff");a.href=deployment.applicationUrl;a.target='_blank';a.rel='noopener noreferrer';remote.append(a,lnode('p',"apps.last_verified_state_refreshing_local_docker__5749c5"));for(const c of deployment.containers)remote.append(node('p',(c.name||c.id.slice(0,12))+' · '+c.state));card.append(remote);}
   if(p.applicationUrl&&(!settings?.configured||settings.enabled)){try{const u=new URL(p.applicationUrl);if(['http:','https:'].includes(u.protocol)){const a=lnode('a',"apps.open_application_1aa2b7");a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';actions.append(a);}}catch{}}
   card.append(actions);if(p.source)card.append(node('p',tApps("apps.source_version_e54e69")+p.source.sha256.slice(0,12)));if(p.health)card.append(node('p',tApps("apps.last_http_check_28f9e6")+(p.health.ok?tApps("apps.passed_9b0ff7")+p.health.status+')':tApps("apps.check_failed_017d4b"))+(p.test?tApps("apps.application_test_passed_2aaece")+(Number.isFinite(p.test.at)?' '+new Date(p.test.at).toLocaleTimeString(appsLocale()):''):'')));projects.append(card);
  }
  const visibleContainers=state.containers.filter(c=>{const p=state.projects.find(p=>p.id===c.projectId);return!p||c.state==='running'||(c.service?c.releaseId===p.releaseId:c.id===p.containerId);});
  const containers=el('apps-containers');containers.replaceChildren();for(const c of visibleContainers){const row=node('tr');row.dataset.appsContainer=c.id;row.append(node('td',(state.projects.find(p=>p.id===c.projectId)?.name||c.name)+(c.service?' / '+c.service:'')),node('td',c.state==='running'?tApps("apps.running_13df22"):status()[c.state]||c.state),node('td',c.ports.map(p=>p.public+' → '+p.private).join(', ')||'—'));const controls=node('td'),power=mutationButton(c.state==='running'?tApps("apps.stop_74083f"):tApps("apps.start_7e4cda"),()=>act('container-action',{id:c.id,action:c.state==='running'?'stop':'start'}),unavailable||busy);if(c.state!=='running')power.dataset.appStartId=c.id;controls.append(button(tApps("apps.logs_0a8f97"),()=>showLog('container',c.id),!state.enabled),power);row.append(controls);containers.append(row);}if(!visibleContainers.length){const row=node('tr'),cell=lnode('td',"apps.no_managed_containers_27f350");cell.colSpan=4;row.append(cell);containers.append(row);}
  const jobs=el('apps-jobs');jobs.replaceChildren();for(const j of state.jobs.slice().reverse()){const row=node('div',undefined,'apps-job');row.dataset.appsJob=j.id;row.append(node('span',(actionNames()[j.action]||j.action)+' · '+(status()[['recovery_required','promoting','publishing'].includes(j.deploymentPhase)?j.deploymentPhase:j.status]||j.status)+(j.stage?' · '+j.stage:'')+(j.verification==='http-only'?tApps("apps.http_availability_only_fbdc91"):'')+(j.error?' · '+j.error:'')),button(tApps("apps.view_log_186b71"),()=>showLog('job',j.id)));if(j.export&&j.status==='passed'){const a=lnode('a',"apps.download_bundle_33c9b2");a.href=contextURL('export-download?id='+encodeURIComponent(j.id));a.dataset.appExport=a.getAttribute('href');a.onclick=event=>{if(recoveryRequired())event.preventDefault();};a.download=j.export.filename;row.append(a);}jobs.append(row);}if(!state.jobs.length)jobs.append(lnode('p',"apps.no_operations_yet_75f8ec"));applySafety();
 }
 async function refresh({afterMutation=false}={}){
  if(!alive()||document.hidden||(embedded&&options.visible&&!options.visible()))return;
  if(view.scope==='project'&&!view.sessionId){setConnectionText(ct('select'));renderContext();return;}
  if(loading){if(afterMutation)refreshAfterMutation=true;return;}
  loading=true;const epoch=stateEpoch;
  try{
   const next=await api('state');
   // A GET begun before a confirmed write cannot replace the saved references.
   if(epoch!==stateEpoch){refreshAfterMutation=true;return;}
   const firstState=state===null;state=next;renderContext();renderConnection();const key=JSON.stringify([state.enabled,state.available,state.error,state.busy,state.worker,state.previewSettings,state.holdUntil,state.draining,state.deploymentRecovery,state.projects,state.containers.map(c=>[c.id,c.name,c.state,c.ports,c.role,c.dataGeneration,c.releaseId,c.canStart]),state.jobs,state.vault?.configured,state.remoteTargets,state.features]);
   if(key!==renderedKey&&!(el('apps-projects').contains(document.activeElement)&&document.activeElement?.matches('input,textarea,select'))){render();renderedKey=key;}
   applySafety();if(firstState){void cleanup?.refresh();void resources?.refresh();}await refreshLog();
  }catch(e){if(alive()&&e.name!=='AbortError')setConnectionText(tApps("apps.application_management_is_unavailable_c57dbf")+e.message);}
  finally{loading=false;if(refreshAfterMutation){refreshAfterMutation=false;if(alive())void refresh();}}
 }
 el('apps-add').onsubmit=e=>{e.preventDefault();void act('register',{path:el('apps-path').value.trim()});};
 el('apps-package').onclick=async()=>{const relative=el('apps-path').value.trim(),result=await act('scaffold',{path:relative});if(result){el('apps-log-panel').hidden=false;el('apps-log-title').textContent=tApps("apps.docker_prepared_184edb")+result.runtime;el('apps-log').textContent=[...result.warnings,...Object.entries(result.files).map(([n,v])=>n+'\n'+v)].join('\n\n');await act('register',{path:relative});}};
 el('apps-vault-form').onsubmit=async e=>{e.preventDefault();if(recoveryRequired()){el('apps-error').textContent=tApps('apps.recovery_help');return;}const result=await act('vault-config',{origin:el('apps-vault-origin').value,clientId:el('apps-vault-client').value.trim(),clientSecret:el('apps-vault-secret').value});if(!alive())return;el('apps-vault-secret').value='';if(result)el('apps-vault-state').textContent=tApps("apps.vault_connection_verified_and_saved_b92edd");};
 el('apps-target-form').onsubmit=e=>{e.preventDefault();const v=targetFields.map(f=>f.input.value.trim());void act('target-settings',{id:v[0],name:v[1],host:v[2],user:v[3],port:Number(v[4]),hostKey:v[5],scope:{projectId:v[6],environment:v[7],secretPath:v[8]},keySecret:v[9]});};
 el('apps-wake').onclick=()=>void act('worker-action',{action:'wake'});el('apps-sleep').onclick=()=>void act('worker-action',{action:'sleep'});el('apps-hold').onclick=()=>void act('hold',{minutes:15});el('apps-release').onclick=()=>void act('hold',{minutes:0});el('apps-preview-save').onclick=()=>void act('preview-settings',{enabled:el('apps-preview-enabled').checked});
 el('apps-close').onclick=()=>panel.close();panel.addEventListener('close',()=>{cancelRequests();restoreFocus?.focus();if(options.transient)destroy();});
 function openView(openOptions={}){if(lifetime.signal.aborted)return;if(embedded)return refresh();if(view.scope==='project'&&!view.sessionId&&(openOptions.scope==='global'||openOptions.settings)){destroy();return window.HarnessApps.mount(undefined,{scope:'global',settings:Boolean(openOptions.settings)}).open(openOptions);}restoreFocus=document.activeElement;if(!panel.open)panel.showModal();if(openOptions.settings){el('apps-settings-group').open=true;el('apps-preview-settings').open=true;}void refresh().then(()=>{if(alive()&&openOptions.settings)el('apps-preview-settings').scrollIntoView({block:'start'});});}
 if(!embedded&&!options.transient)window.openHarnessApps=openView;
 prepare.onclick=async()=>{if(!view.sessionId||contextInvalid)return;const result=await act('scaffold',{});if(result)await act('register',{});};
 rebind.onclick=()=>{bindingEpoch++;stateEpoch++;cancelRequests();boundProjectId=null;contextInvalid=false;state=null;selectedLog=null;renderedKey='';el('apps-projects').replaceChildren();el('apps-containers').replaceChildren();el('apps-jobs').replaceChildren();el('apps-log-panel').hidden=true;el('apps-error').textContent='';renderContext();void refresh({afterMutation:true});};
 admin.onclick=()=>{if(!window.HarnessNativeUI?.openSettings('harness-deployment'))window.HarnessApps.mount(undefined,{scope:'global',settings:true,transient:true}).open({settings:true});};
 allApps.onclick=()=>window.HarnessApps.mount(undefined,{scope:'global',transient:true}).open();
 const languageChanged=()=>{if(!alive())return;const origin=el('apps-vault-origin').value,client=el('apps-vault-client').value;if(state)render();el('apps-vault-origin').value=origin;el('apps-vault-client').value=client;applyCopy();renderContext();};
 window.addEventListener('harness-language-change',languageChanged,{signal:lifetime.signal});applyCopy();renderContext();
 if(options.settings&&view.scope==='global'){
  style.textContent+=`#${panel.id} .apps-cleanup{margin-top:24px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l3,#dce5e9);min-width:0}#${panel.id} .apps-cleanup fieldset{min-width:0;margin:16px 0;padding:12px;border:1px solid var(--dsw-alias-border-l3,#dce5e9);border-radius:8px}#${panel.id} .apps-cleanup legend{font-weight:600}#${panel.id} .apps-cleanup-resource{border-top:1px solid var(--dsw-alias-border-l3,#dce5e9);padding:12px 0}#${panel.id} .apps-cleanup-resource:first-of-type{border-top:0}#${panel.id} .apps-cleanup :where(label,p,strong){overflow-wrap:anywhere;white-space:normal}#${panel.id} .apps-cleanup label{display:flex;gap:10px;align-items:flex-start}#${panel.id} .apps-cleanup input[type=checkbox]{flex:0 0 auto;width:18px;height:18px;margin-top:3px}#${panel.id} .apps-cleanup p{margin:8px 0}#${panel.id} .apps-cleanup-review{padding:12px;border:1px solid var(--dsw-alias-border-l3,#dce5e9);border-radius:8px}#${panel.id} .apps-cleanup button{white-space:normal;margin:4px 8px 4px 0;max-width:100%}`;
  cleanup=mountCleanup(el('apps-settings-group'),cleanupAdapter(lifetime.signal,()=>state),{signal:lifetime.signal,blocked:()=>!state||contextInvalid||recoveryRequired()||!!state.busy||acting||state.worker?.phase==='saving'});
 }
 resources=mountResourceInventory(contextBox,{api,url:contextURL,logs:id=>showLog('container',id),signal:lifetime.signal,scope:view.scope,sessionId:view.sessionId,visible:()=>alive()&&!document.hidden&&(!options.visible||options.visible()),blocked:()=>!state||contextInvalid||recoveryRequired()||!!state.busy||acting||state.worker?.phase==='saving'});
 const timer=setInterval(()=>void refresh(),5000);
 const cleanupTimer=cleanup?setInterval(()=>{cleanup.updateSafety();},500):null;
 void refresh();
 function destroy(){clearInterval(timer);clearInterval(cleanupTimer);cleanup?.destroy();resources?.destroy();lifetime.abort();cancelRequests();credentialEditors.clear();panel.remove();style.remove();}
 return{element:panel,refresh,open:openView,async useProject(relative){if(!alive())return false;el('apps-path').value=relative;const result=await act('scaffold',{path:relative});if(!result)return false;return Boolean(await act('register',{path:relative}));},destroy};
 }};
function mountResourceInventory(anchor,adapter){
 const cs=()=>window.HarnessI18n?.language==='cs',t=(en,cz)=>cs()?cz:en,node=(tag,value)=>{const e=document.createElement(tag);if(value!==undefined)e.textContent=value;return e;},button=(label,fn)=>{const e=node('button',label);e.type='button';e.onclick=fn;return e;};
 const box=node('section');box.className='apps-resource-inventory';box.dataset.resourceScope=adapter.scope;box.style.overflowWrap='anywhere';anchor.after(box);
 const title=node('h3'),filters=node('div'),search=node('input'),kind=node('select'),stateFilter=node('select'),refresh=button('',()=>void load()),more=button('',()=>void load(true)),summary=node('p'),error=node('p'),list=node('div'),review=node('section'),receipt=node('section');error.setAttribute('role','alert');receipt.setAttribute('aria-live','polite');
 search.type='search';search.setAttribute('aria-label',t('Find images or containers','Vyhledat images nebo kontejnery'));search.placeholder=t('Name or ID','Název nebo ID');kind.setAttribute('aria-label',t('Resource type','Typ zdroje'));stateFilter.setAttribute('aria-label',t('State','Stav'));
 for(const [value,en,cz]of [['all','All resources','Všechny zdroje'],['image','Images','Images'],['container','Containers','Kontejnery']]){const option=node('option',t(en,cz));option.value=value;kind.append(option);}
 for(const [value,en,cz]of [['all','All states','Všechny stavy'],['active','Running','Běžící'],['inactive','Inactive','Neaktivní']]){const option=node('option',t(en,cz));option.value=value;stateFilter.append(option);}
 filters.style.cssText='display:flex;flex-wrap:wrap;gap:8px';search.style.cssText='min-width:0;max-width:100%;flex:1 1 160px';filters.append(search,kind,stateFilter,refresh);box.append(title,filters,summary,error,list,more,review,receipt);
 const storageKey='harness.resources.pending.'+adapter.scope+':'+(adapter.sessionId||'global');let inventory=null,rows=[],epoch=0,busy=false,plan=null,operation=null,pending=null,poll,searchTimer,closed=false;
 try{const saved=JSON.parse(sessionStorage.getItem(storageKey)||'null');if(saved&&/^[a-f0-9]{32}$/.test(saved.operationId))pending=saved;}catch{}
 const alive=()=>!closed&&!adapter.signal.aborted,blocked=()=>busy||Boolean(pending)||adapter.blocked(),bytes=value=>Number.isFinite(value)?(value/1048576).toLocaleString(window.HarnessI18n?.locale,{maximumFractionDigits:1})+' MiB':'—';
 const savePending=value=>{pending=value;try{if(value)sessionStorage.setItem(storageKey,JSON.stringify(value));else sessionStorage.removeItem(storageKey);}catch{}};
 const operationId=()=>crypto.randomUUID().replaceAll('-','');
 function render(){
  title.textContent=t(adapter.scope==='global'?'All known Docker images and containers':'This conversation’s Docker resources',adapter.scope==='global'?'Všechny známé Docker images a kontejnery':'Docker zdroje této konverzace');refresh.textContent=t('Refresh inventory','Obnovit inventuru');more.textContent=t('Load more','Načíst další');refresh.disabled=busy;more.hidden=!inventory?.nextCursor;more.disabled=busy;
  summary.textContent=inventory?t('Observed: ','Pozorováno: ')+(inventory.observedAt?new Date(inventory.observedAt).toLocaleString(window.HarnessI18n?.locale):t('unknown','neověřeno'))+' · '+inventory.availability+(inventory.stale?' · '+t('retained snapshot, not a live census','uložená inventura, nikoli živý přehled'):'')+' · '+rows.length+' / '+(inventory.totalKnown??'?')+' '+t('known resources','známých zdrojů'):t('Inventory has not been observed.','Inventura zatím není ověřena.');
  list.replaceChildren();const selectedRows=rows.filter(item=>stateFilter.value==='all'||(stateFilter.value==='active')===['running','restarting'].includes(item.state));
  for(const item of selectedRows){const card=node('article');card.className='apps-resource';card.dataset.resourceId=item.id;card.append(node('h4',item.name||item.id),node('p',item.kind+' · '+item.state+' · '+bytes(item.sizeBytes)),node('small',item.id));if(item.shared)card.append(node('p',t('Shared image — used by multiple projects','Sdílený image — používá více projektů')));if(item.protected)card.append(node('p',t('Protected: ','Chráněno: ')+(item.reasons||[]).join(', ')));if(adapter.scope==='global'&&item.sessionIds?.length)card.append(node('p',t('Conversations: ','Konverzace: ')+item.sessionIds.join(', ')));
   if(item.kind==='container'&&adapter.logs)card.append(button(t('Logs','Logy'),()=>adapter.logs(item.id)));
   for(const [action,en,cz]of [['stop','Stop','Zastavit'],['delete','Delete','Smazat'],['export','Export / download','Export / stáhnout']]){const allowed=Array.isArray(item.actions)?item.actions.includes(action):item.actions?.[action]===true;if(!allowed)continue;const control=button(t(en,cz),()=>void preview(item,action));control.disabled=blocked()||inventory?.stale||inventory?.availability!=='ready'||(item.protected&&action!=='export');card.append(control);}list.append(card);
  }
  if(!selectedRows.length)list.append(node('p',t('No matching resources in the loaded inventory.','V načtené inventuře nejsou odpovídající zdroje.')));
  renderReceipt();
 }
 async function load(append=false){if(!alive()||busy)return;const ticket=++epoch;busy=true;plan=null;review.replaceChildren();error.textContent='';render();try{const query=new URLSearchParams({kind:kind.value,q:search.value,limit:'50'});if(append&&inventory?.nextCursor)query.set('cursor',inventory.nextCursor);const data=await adapter.api('resources?'+query);if(!alive()||ticket!==epoch)return;if(data.version!==1||!Array.isArray(data.items))throw Error(t('Invalid resource inventory','Neplatná inventura zdrojů'));if(append&&inventory&&data.inventoryId!==inventory.inventoryId)throw Error(t('Inventory changed. Refresh before loading another page.','Inventura se změnila. Před další stránkou ji obnov.'));inventory=data;rows=append?[...rows,...data.items.filter(item=>!rows.some(old=>old.kind===item.kind&&old.id===item.id))]:data.items;}catch(e){if(alive()&&ticket===epoch){error.textContent=e.message;if(inventory)inventory={...inventory,stale:true};}}finally{if(alive()&&ticket===epoch){busy=false;render();if(pending)void reconcile();}}}
 async function preview(item,action){if(!alive()||blocked()||!inventory)return;busy=true;error.textContent='';render();const request={kind:item.kind,id:item.id,action,phase:'preview',inventoryId:inventory.inventoryId,operationId:operationId(),...(adapter.scope==='global'?{confirmGlobal:true}:{})};try{const data=await adapter.api('resource-action',request);if(!alive())return;const p=data.plan;if(data.version!==1||!p||p.id!==item.id||p.kind!==item.kind||p.action!==action||!p.planId||!p.planHash)throw Error(t('Invalid operation plan','Neplatný plán operace'));plan={...request,...p};review.replaceChildren(node('h4',t('Review operation','Kontrola operace')),node('p',action+' · '+(item.name||item.id)),node('p',p.warning||''));if(action==='delete'&&item.kind==='container')review.append(node('p',t('Deleting loses the container’s writable layer. Volumes are not deleted.','Smazání odstraní zapisovatelnou vrstvu kontejneru. Volumes se nemažou.')));if(action==='export')review.append(node('p',item.kind==='image'?t('Docker image archive. Does not include running containers or volumes.','Archiv Docker image. Neobsahuje běžící kontejnery ani volumes.'):t('Container filesystem only. Excludes volumes and full restore configuration.','Pouze souborový systém kontejneru. Bez volumes a úplné konfigurace pro obnovu.')));if(p.blocked)review.append(node('p',(p.reasons||[]).join(', ')));else review.append(button(t('Confirm this operation','Potvrdit tuto operaci'),()=>void apply()));review.append(button(t('Cancel','Zrušit'),()=>{plan=null;review.replaceChildren();}));}catch(e){if(alive())error.textContent=e.message;}finally{busy=false;if(alive())render();}}
 async function apply(){if(!alive()||blocked()||!plan||plan.blocked)return;const target=plan;if(target.expiresAt<=Date.now()){error.textContent=t('Plan expired. Preview again.','Plán vypršel. Znovu zobraz náhled.');return;}busy=true;savePending({operationId:target.operationId,kind:target.kind,id:target.id,action:target.action});plan=null;review.replaceChildren();error.textContent='';render();try{const data=await adapter.api('resource-action',{phase:'apply',action:target.action,kind:target.kind,id:target.id,inventoryId:target.inventoryId,operationId:target.operationId,planId:target.planId,planHash:target.planHash,...(adapter.scope==='global'?{confirmGlobal:true}:{})});if(alive())acceptReceipt(data);}catch(e){if(alive())error.textContent=t('Outcome not confirmed. Check the original operation; do not repeat it. ','Výsledek není potvrzený. Ověř původní operaci; neopakuj ji. ')+e.message;}finally{busy=false;if(alive()){render();scheduleReceipt();}}}
 function acceptReceipt(data){if(data.version!==1||!data.operation||data.operation.operationId!==pending?.operationId)throw Error(t('Invalid operation receipt','Neplatné potvrzení operace'));operation=data.operation;if(['completed','failed'].includes(operation.state))savePending(null);}
 async function reconcile(){if(!alive()||!pending||busy)return;try{const data=await adapter.api('resources?operationId='+encodeURIComponent(pending.operationId));if(alive()){acceptReceipt(data);render();}}catch(e){if(alive())error.textContent=e.message;}finally{scheduleReceipt();}}
 function scheduleReceipt(){clearTimeout(poll);if(alive()&&pending&&operation?.state!=='reconciliation_required'&&adapter.visible())poll=setTimeout(()=>void reconcile(),2500);}
 function renderReceipt(){receipt.replaceChildren();if(!pending&&!operation)return;receipt.append(node('h4',t('Operation status','Stav operace')),node('p',operation?.state||t('Not confirmed','Nepotvrzeno')),node('small',operation?.operationId||pending.operationId));if(operation?.errorCode)receipt.append(node('p',operation.errorCode));if(pending)receipt.append(button(t('Check original operation','Ověřit původní operaci'),()=>void reconcile()));const exported=operation?.export;if(operation?.state==='completed'&&exported){receipt.append(node('p',exported.format+' · '+bytes(exported.bytes)),node('p',t('No volumes or full restore configuration are included.','Neobsahuje volumes ani úplnou konfiguraci pro obnovu.')));if(exported.expiresAt>Date.now()){const link=node('a',t('Download export','Stáhnout export'));link.href=adapter.url('resource-export-download?operationId='+encodeURIComponent(operation.operationId));link.download='';receipt.append(link);}else receipt.append(node('p',t('Download expired.','Platnost stažení skončila.')));}}
 search.oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>void load(),350);};kind.onchange=()=>void load();stateFilter.onchange=render;const language=()=>render();window.addEventListener('harness-language-change',language);render();
 return{refresh:()=>load(),destroy(){closed=true;++epoch;clearTimeout(poll);clearTimeout(searchTimer);window.removeEventListener('harness-language-change',language);box.remove();}};
}
 window.HarnessDockerResources={mount:mountResourceInventory};
 if(!window.HARNESS_NATIVE_WORKBENCH)window.HarnessApps.mount();
})();
