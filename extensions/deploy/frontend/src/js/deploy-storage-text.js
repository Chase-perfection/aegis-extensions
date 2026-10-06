/**
 * Every sentence of the storage page, in English.
 *
 * The translations live in core (`translations.js`, keys `deploy_storage_*`),
 * because that is where the language switch reads them. This table is the
 * fallback: an extension is published on its own schedule, and on an Aegis that
 * predates these keys the page has to say something better than a key name.
 *
 * One table rather than a fallback at each call, for the checks. The server
 * answers a check with an id and a code, and the sentence is looked up from the
 * two. Scattered through the code, a new code would have no sentence and nobody
 * would see which one.
 *
 * `$1` and `$2` are replaced by `T`.
 */

(function () {
    'use strict';

    var EN = {
        gear: 'Data storage',
        title: 'Data storage',
        intro: 'Where this project keeps what it has to remember: in files on this server, or in a Postgres database you run elsewhere.',
        back_to_project: 'Back to the project',
        loading: 'Reading the storage settings.',
        unreachable: 'Aegis did not answer. Check the backend is running, then reload this page.',
        too_old: 'This version of Aegis cannot reach a Postgres database. Update Aegis on this server to use an external database.',

        now_local: 'The data is in local files on this server',
        now_local_detail: 'The application reads and writes $1 in its data folder.',
        now_external: 'The data is in an external database',
        now_external_detail: '$1, database $2.',
        active: 'Active',
        card_local: 'Local files',
        card_local_1: 'One SQLite file in the project\'s data folder, on this server.',
        card_local_2: 'Nothing to install and nothing to connect.',
        card_local_3: 'Backed up with the server. One site writes to it at a time.',
        card_external: 'External database',
        card_external_1: 'A Postgres database you run, for example a Supabase stack.',
        card_external_2: 'Other tools can read the same data, and it has its own backups.',
        card_external_3: 'The project\'s code has to support Postgres.',
        setup: 'Set up an external database',
        resume: 'Continue the setup',
        open_console: 'Open the database console',
        go_back: 'Go back to local files',
        switched: 'Switched $1 by $2.',

        rotate_title: 'The database password changed?',
        rotate_body: 'Type the new one. Aegis checks it against the database before keeping it.',
        rotate_button: 'Check and save',
        rotate_saved: 'Saved. Redeploy the project so the site uses it.',
        rotate_refused: 'The database refused this password. Nothing was changed.',

        step_1: 'Address',
        step_2: 'Credentials',
        step_3: 'Checks',
        step_4: 'Data',
        step_5: 'Switch',
        next: 'Continue',
        previous: 'Back',
        cancel: 'Cancel',
        working: 'Working.',

        kind: 'Type of database',
        kind_supabase: 'Supabase',
        kind_postgres: 'Another Postgres server',
        host: 'Host',
        port: 'Port',
        database: 'Database',
        ssl: 'Require SSL',
        console: 'Console address',
        user: 'User',
        password: 'Password',
        password_kept: 'Saved. Leave empty to keep it.',

        help_kind: 'Only changes the explanations on this page. Both connect the same way.',
        help_host_supabase: 'The machine that runs your Supabase stack. It is the address of your Studio, without http:// and without the port.',
        help_host_postgres: 'The name or IP address of the Postgres server, without a port.',
        help_port_supabase: 'The Postgres port in session mode, not the Studio port. A self-hosted stack uses 5432 unless it was moved.',
        help_port_postgres: '5432 unless your administrator chose another.',
        help_database_supabase: 'postgres, unless you created another database in the stack.',
        help_database_postgres: 'The database this site will own. Create it empty first.',
        help_ssl: 'Tick it when the database is outside your network. On an internal address it can stay off.',
        help_console_supabase: 'Optional. The address of your Studio, with http:// and its port. The Data tab links to it.',
        help_console_postgres: 'Optional. The address of your admin tool, pgAdmin for example. The Data tab links to it.',
        help_user_supabase: 'On a self-hosted stack: postgres.<tenant>, where <tenant> is the POOLER_TENANT_ID of the stack. Straight to Postgres with no pooler: postgres.',
        help_user_postgres: 'A role allowed to create tables in this database.',
        help_password_supabase: 'POSTGRES_PASSWORD in the .env file of the stack. Aegis stores it encrypted and never shows it again.',
        help_password_postgres: 'The password of that role. Aegis stores it encrypted and never shows it again.',

        bad_kind: 'Pick a type of database.',
        bad_host: 'The host is a name or an IPv4 address, with no http:// and no port.',
        bad_port: 'The port is a number from 1 to 65535.',
        bad_database: 'The database name is letters, digits, _ . $ and -.',
        bad_user: 'The user is letters, digits, _ . $ and -.',
        bad_console_url: 'The console address starts with http:// or https://.',
        bad_password: 'That password is too long.',
        switch_back_first: 'This project is running on its database. Go back to local files before pointing it at another one.',
        check_failed: 'Aegis could not run the checks.',

        approve_title: 'This address is not approved on this server yet',
        approve_body: 'A site is normally forbidden from reaching your internal network. An administrator approves each database address once, on the Aegis server itself. Run this there, in PowerShell as administrator:',
        approve_note: 'No restart is needed. Then click Check again.',
        check_again: 'Check again',
        run_checks: 'Run the checks again',

        check_runtime: 'The project is served by a process',
        check_runtime_static_project: 'This project serves files and runs no process, so nothing here reads a database.',
        check_runtime_preview: 'A preview keeps its own local files. Set the storage on the project it branches from.',
        check_runtime_runtime_off: 'This server does not run application processes yet. Finish Deploy\'s setup on the host first.',
        check_runtime_never_deployed: 'This project has not published a version yet. Deploy it once, then come back.',
        check_capability: 'This Aegis can reach a Postgres database',
        check_capability_core_too_old: 'This version cannot. Update Aegis on this server, then come back.',
        check_approved: 'The address is approved on this server',
        check_approved_not_approved: 'Not yet. Step 1 shows the command to run on the server.',
        check_ssl: 'The connection is protected',
        check_ssl_ssl_on: 'SSL is required on this connection.',
        check_ssl_private: 'A private address. Plain Postgres on an internal network is an accepted risk.',
        check_ssl_public_no_ssl: 'This address is reachable from outside your network and SSL is off. Tick Require SSL in step 1.',
        check_reachable: 'The database answers',
        check_reachable_no_answer: 'Nothing answered at this address and port ($1). Check both, and that the database\'s own firewall lets the Aegis server in.',
        check_login: 'The user and password are accepted',
        check_login_ok: 'Connected as $1.',
        check_login_no_password: 'No password yet. Type it in step 2.',
        check_login_refused: 'The database refused the login: $1',
        check_version: 'Postgres 13 or newer',
        check_version_ok: 'Postgres $1.',
        check_version_too_old: 'This server runs Postgres $1. Upgrade it to 13 or newer.',
        check_version_not_postgres: 'This server did not answer like Postgres.',
        check_create: 'The user may create tables',
        check_create_no_create: 'The database refused: $1. Give this user the right to create tables here, or use the owner of the database.',
        check_code: 'The project\'s code can use Postgres',
        check_code_ok: '$1 migration file(s) found.',
        check_code_no_migrations: 'The version on the port has no file in $1. Its code still expects the local file, and switching would break the site. Add Postgres support to the project, deploy it, then come back.',
        check_path: 'The site can reach the database through this server\'s firewall',
        check_path_not_blocked: 'No rule blocks this address.',
        check_path_will_open: 'Blocked today. At the switch, Aegis opens $1 for this site\'s account, and nothing else on that machine.',
        check_path_blocked_unmanaged: 'A firewall rule blocks $1 for sites, and Aegis is not allowed to change the firewall on this server. Finish Deploy\'s setup on the host.',
        check_path_unknown: 'Aegis could not read the firewall rules: $1',
        check_not_asked: 'Not asked: the one above has to pass first.',
        checks_ok: 'Every check passed.',

        data_intro: 'A rehearsal: Aegis created the tables and copied every row inside a transaction, then undid it. The database is as it was, and the site did not stop.',
        data_running: 'Rehearsing the copy.',
        data_none: 'The local file holds no table. The site starts on an empty database.',
        data_migrations: 'Tables created by: $1',
        data_rows: '$1 row(s) in the file',
        data_ok: 'Copied in the rehearsal.',
        data_ok_replace: 'Copied in the rehearsal. The $1 row(s) the database holds are replaced.',
        data_empty: 'Empty. Nothing to copy.',
        data_missing_table: 'No table of this name in the database. Its rows would be lost, so the switch is refused. Add the table to a Postgres migration of the project.',
        data_missing_columns: 'The database table lacks: $1. Add them in a Postgres migration of the project.',
        data_not_empty: 'The database table already holds rows.',
        data_not_empty_foreign: 'Aegis does not write over rows it did not copy. Use an empty database.',
        data_replace: 'Replace what the database holds with the content of the local file',
        data_replace_help: 'Ticking this deletes the rows these tables hold in the database, then copies the file again. Rows written there since the earlier switch are lost.',
        data_unreadable: 'Aegis could not count the rows of this table in the local file. Try again in a moment.',
        data_failed: 'The rehearsal was refused: $1',
        data_rls_title: 'Row level security is off on some tables',
        data_rls: 'Tables: $1. A Supabase stack serves the public schema through its API to whoever holds its anon key. Turn it on in a migration (ALTER TABLE ... ENABLE ROW LEVEL SECURITY). The site keeps full access as the owner.',
        data_good: 'The copy works.',
        not_approved: 'This address is no longer approved on this server. Go back to step 1.',
        no_target: 'No password is saved for this connection. Go back to step 2.',
        never_deployed: 'This project has not published a version yet.',

        switch_what: 'What happens when you confirm',
        switch_1: 'The site stops. Visitors see an error page for as long as the copy takes.',
        switch_2: 'Aegis creates the tables and copies every row, then compares the counts.',
        switch_3: 'The site restarts on the external database, and Aegis waits for it to answer.',
        switch_4: 'If anything fails, the site restarts on its local file, as it was.',
        switch_keep: 'The local file is kept untouched. It is your way back.',
        switch_password: 'Your Aegis password',
        switch_password_help: 'Asked again because this stops a site. It is your Aegis password, not the database\'s.',
        switch_button: 'Switch to the external database',
        switch_running: 'Switching. Keep this page open.',
        password_refused: 'Aegis refused that password. Nothing was changed.',
        deploy_in_progress: 'A deployment of this project is running. Wait for it to finish, then try again.',
        already_on_postgres: 'This project already runs on its external database.',
        already_local: 'This project already runs on its local file.',
        egress_set: 'This project has an internal network access set in Settings, and a project holds one opening at a time. Remove it in Settings, Internal network access, then switch.',

        result_ok: 'The site now runs on the external database',
        result_ok_detail: '$1 row(s) copied.',
        result_failed: 'The switch was refused',
        result_restored: 'The site is running on its local file, as before.',
        result_down: 'The site did not restart. Open Deployments and redeploy it: it will start on its local file.',
        result_never_stopped: 'The site never stopped.',
        step_checks: 'Checks',
        step_rehearsal: 'Rehearsal, with the site running',
        step_stop: 'Site stopped',
        step_copy: 'Data copied',
        step_start: 'Site started',
        step_undo: 'Copied rows removed from the database',
        step_restore: 'Site restarted on its local file',
        done: 'Done',

        back_title: 'Go back to local files',
        back_body: 'The site restarts on its local file, as it was at the switch. Rows written to the external database since then stay there and are not copied back.',
        back_keep: 'The connection is kept, so you can switch again later.',
        back_button: 'Go back to local files',
        back_done: 'The site runs on its local file again',
        back_failed: 'The site would not start on its local file. It is still running on the external database.',

        summary_body: 'This project keeps its data in an external database. Browse and edit it in the database\'s own console.',
        summary_healthy: 'The database answers',
        summary_down: 'The database does not answer',
        summary_tables: '$1 row(s)',
        summary_no_tables: 'The database holds no table yet.',
        summary_more: 'More tables exist than are listed here.',
        summary_settings: 'Storage settings',
        summary_files: 'The local file from before the switch is still in the data folder, unchanged.'
    };

    function tr(key, fallback) {
        var v = (typeof t === 'function') ? t(key) : null;
        return v && v !== key ? v : fallback;
    }

    /** One sentence, by its short key, with `$1` and `$2` filled in. */
    function T(key, a, b) {
        var text = tr('deploy_storage_' + key, EN[key] === undefined ? key : EN[key]);
        if (a !== undefined) text = text.replace('$1', a);
        if (b !== undefined) text = text.replace('$2', b);
        return text;
    }

    /** Whether a sentence exists for this key, so a code nobody wrote one for shows as itself. */
    function has(key) {
        return EN[key] !== undefined;
    }

    window.DeployStorageText = { T: T, has: has, EN: EN };
})();
