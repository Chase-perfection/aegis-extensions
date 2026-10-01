# account-tiering : clés de traduction

339 clés, toutes préfixées `at_`. Colonne FR : le texte de repli écrit dans le code. Colonne EN : la traduction à livrer dans `translations.js` du cœur.
Les paramètres entre accolades sont identiques dans les deux langues. Les formes au pluriel sont des clés séparées (`_one` / `_many`).

| Clé | FR | EN |
|---|---|---|
| `at_accounts_hint` | Cliquez un compte pour ouvrir son arbre. | Click an account to open its tree. |
| `at_accounts_label` | Comptes · {n} | Accounts · {n} |
| `at_banner_norules` | Aucune règle de tiering : tous les comptes sont considérés Tier 2, les administrateurs légitimes apparaissent en écart. | No tiering rule: every account is treated as Tier 2, so legitimate administrators show up as gaps. |
| `at_banner_norules_action` | Définir les règles | Define the rules |
| `at_banner_poll_failed` | Le suivi de l'analyse s'est arrêté : son état n'a pas pu être lu. {reason} | Tracking of the analysis stopped: its status could not be read. {reason} |
| `at_banner_scan_failed` | La dernière analyse a échoué. {reason} | The last analysis failed. {reason} |
| `at_banner_scanning` | Analyse en cours : la page se met à jour à la fin. | Analysis running: the page updates when it ends. |
| `at_banner_truncated` | Chaîne tronquée à {n} niveaux : des droits plus lointains peuvent manquer. Augmentez le nombre de passes dans les paramètres de l’analyse. | Chain cut at {n} levels: rights further away may be missing. Raise the number of passes in the analysis settings. |
| `at_banner_unreadable_many` | {n} objets n’ont pas pu être lus : le résultat est partiel. | {n} objects could not be read: the result is partial. |
| `at_banner_unreadable_one` | {n} objet n’a pas pu être lu : le résultat est partiel. | {n} object could not be read: the result is partial. |
| `at_cancel` | Annuler | Cancel |
| `at_cell_chip` | Prévu T{p} · effectif T{e} | Planned T{p} · effective T{e} |
| `at_cell_clear` | Retirer ce filtre | Remove this filter |
| `at_cell_toast` | Liste filtrée : prévu Tier {p}, effectif Tier {e}. | List filtered: planned Tier {p}, effective Tier {e}. |
| `at_chain_acl` | {right} sur {target} | {right} on {target} |
| `at_chain_gpo_edit` | modification de {gpo} | edit of {gpo} |
| `at_chain_gpo_local` | {group} via {gpo} | {group} via {gpo} |
| `at_close` | Fermer | Close |
| `at_col_account` | Compte | Account |
| `at_col_accounts` | Comptes | Accounts |
| `at_col_groups` | Groupes directs | Direct groups |
| `at_col_groups_inv` | Groupes | Groups |
| `at_col_mech` | Mécanisme | Mechanism |
| `at_col_mechs` | Mécanismes | Mechanisms |
| `at_col_target` | Cible | Target |
| `at_col_tier` | Tier atteint | Tier reached |
| `at_copied` | Commande copiée. | Command copied. |
| `at_copy` | Copier | Copy |
| `at_copy_failed` | Copie impossible : sélectionnez la commande à la main. | Could not copy: select the command by hand. |
| `at_crumb` | Gestion du parc › Arbre des comptes | Asset management › Account tree |
| `at_crumb_computer` | Compte ordinateur | Computer account |
| `at_crumb_group` | Groupe | Group |
| `at_crumb_pair` | {a} › {b} | {a} › {b} |
| `at_crumb_service` | Compte de service | Service account |
| `at_crumb_tier` | {name} › Tier {tier} · {tn} | {name} › Tier {tier} · {tn} |
| `at_crumb_user` | Compte utilisateur | User account |
| `at_date_at` | {date} à {time} | {date} at {time} |
| `at_depth` | Profondeur | Depth |
| `at_depth_2` | Compte et groupes | Account and groups |
| `at_depth_3` | Jusqu'aux mécanismes | Down to the mechanisms |
| `at_depth_4` | Jusqu'au tier atteint | Down to the tier reached |
| `at_depth_label` | Profondeur : {n} | Depth: {n} |
| `at_depth_n` | {n} niveaux | {n} levels |
| `at_direct_desc` | Droits accordés au compte lui-même, sans passer par un groupe. | Rights granted to the account itself, not through a group. |
| `at_direct_name` | Droits directs | Direct rights |
| `at_direct_sub` | sur le compte lui-même | on the account itself |
| `at_domain_current` | domaine du serveur Aegis | domain of the Aegis server |
| `at_ecart_only` | Écarts seulement | Gaps only |
| `at_err_collector_blocked` | L'antivirus a bloqué le script de collecte. | The antivirus blocked the collection script. |
| `at_err_collector_failed` | Le script de collecte a échoué, ou ses résultats ne se lisent pas. | The collection script failed, or its results cannot be read. |
| `at_err_domain_unreachable` | Le serveur Aegis n'est pas membre du domaine, ou aucun contrôleur de domaine n'a répondu. | The Aegis server is not a member of the domain, or no domain controller answered. |
| `at_err_facts_schema` | La dernière analyse a un format que cette version de l'extension ne lit pas : relancez l'analyse. | The last analysis has a format this version of the extension cannot read: run the analysis again. |
| `at_err_forbidden` | Cette page est réservée aux administrateurs du tenant. | This page is reserved for the tenant's administrators. |
| `at_err_internal` | Le serveur a rencontré une erreur. Son journal en donne le détail. | The server hit an error. Its log has the detail. |
| `at_err_invalid_domain` | Le domaine doit être un nom DNS, par exemple corp.local, ou rester vide pour le domaine du serveur. | The domain must be a DNS name, for example corp.local, or stay empty for the server's own domain. |
| `at_err_invalid_passes` | Le nombre de passes va de 1 à 5. | The number of passes goes from 1 to 5. |
| `at_err_invalid_rules` | Une règle est invalide : chaque règle a un type, un motif de 256 caractères au plus et un tier 0, 1 ou 2. Une règle de groupe attend un SID. | A rule is invalid: each rule has a type, a pattern of at most 256 characters and a tier 0, 1 or 2. A group rule expects a SID. |
| `at_err_invalid_sid` | Ce compte n'a pas un SID valide. | This account has no valid SID. |
| `at_err_invalid_tier` | Le tier doit être 0, 1 ou 2. | The tier must be 0, 1 or 2. |
| `at_err_network` | Le serveur Aegis n'a pas répondu. Vérifiez qu'il tourne, puis rechargez la page. | The Aegis server did not answer. Check that it is running, then reload the page. |
| `at_err_no_scan_yet` | Aucune analyse n'a encore été faite. | No analysis has been run yet. |
| `at_err_powershell_missing` | powershell.exe est introuvable sur le serveur Aegis. | powershell.exe was not found on the Aegis server. |
| `at_err_reason_required` | Indiquez le motif de la correction (256 caractères au plus). | Give the reason for the correction (256 characters at most). |
| `at_err_scan_interrupted` | Le service Aegis a redémarré pendant l'analyse. | The Aegis service restarted during the analysis. |
| `at_err_scan_running` | Une analyse est déjà en cours. | An analysis is already running. |
| `at_err_scan_timeout` | L'analyse a dépassé 10 minutes et a été arrêtée. | The analysis ran past 10 minutes and was stopped. |
| `at_err_store_unavailable` | Cette version d'Aegis ne fournit pas de stockage aux extensions : mettez Aegis à jour. | This version of Aegis gives extensions no storage: update Aegis. |
| `at_err_unknown` | Erreur inattendue ({code}). | Unexpected error ({code}). |
| `at_error_title` | L'arbre des comptes ne peut pas s'afficher | The account tree cannot be shown |
| `at_export` | Exporter | Export |
| `at_export_csv` | CSV | CSV |
| `at_export_csv_note` | Comptes, chemins et tiers | Accounts, paths and tiers |
| `at_export_json` | JSON | JSON |
| `at_export_json_note` | Modèle complet, pour un SIEM | Full model, for a SIEM |
| `at_fact_accounts` | Comptes | Accounts |
| `at_fact_effective` | Tier effectif | Effective tier |
| `at_fact_gaps` | En écart | In gap |
| `at_fact_given` | Tier donné | Tier given |
| `at_fact_groups` | Groupes | Groups |
| `at_fact_mechs` | Mécanismes | Mechanisms |
| `at_fact_members` | Membres | Members |
| `at_fact_paths` | Chemins | Paths |
| `at_fact_planned` | Tier prévu | Planned tier |
| `at_fact_rel` | Relation | Relation |
| `at_filter_all` | Tous | All |
| `at_filter_label` | Tier effectif | Effective tier |
| `at_fit` | Ajuster à l'écran | Fit to screen |
| `at_fix_confirm` | Marquer comme proposée | Mark as proposed |
| `at_fix_done` | Remédiation proposée | Remediation proposed |
| `at_fix_lede` | Chaque étape coupe ce chemin à elle seule : choisissez celle qui respecte votre organisation. | Each step cuts this path on its own: pick the one that fits your organisation. |
| `at_fix_meta_many` | {name} · {n} actions | {name} · {n} actions |
| `at_fix_meta_one` | {name} · {n} action | {name} · {n} action |
| `at_fix_nothing_text` | Le compte est marqué « remédiation proposée ». Un administrateur Tier 0 exécute ces étapes lui-même, après validation. | The account is marked "remediation proposed". A Tier 0 administrator runs these steps, after approval. |
| `at_fix_nothing_title` | Rien n'est appliqué maintenant | Nothing is applied now |
| `at_fix_open` | Proposer une remédiation | Propose a remediation |
| `at_fix_title` | Proposer une remédiation | Propose a remediation |
| `at_fix_toast` | Remédiation proposée pour {sam}. | Remediation proposed for {sam}. |
| `at_fold_accounts` | + {n} comptes | + {n} accounts |
| `at_fold_back` | Replier les groupes | Fold the groups |
| `at_fold_by_tier` | {n} vers T{tier} | {n} to T{tier} |
| `at_fold_click` | cliquer pour déplier | click to unfold |
| `at_fold_groups` | + {n} groupes | + {n} groups |
| `at_fold_mechs_many` | {n} mécanismes | {n} mechanisms |
| `at_fold_mechs_one` | {n} mécanisme | {n} mechanism |
| `at_fold_shown` | {n} groupes affichés | {n} groups shown |
| `at_gain_0` | le contrôle du domaine | control of the domain |
| `at_gain_1` | l'administration de serveurs | administration of servers |
| `at_gain_2` | l'accès aux postes de travail | access to workstations |
| `at_ghost_many` | {n} autres groupes | {n} other groups |
| `at_ghost_one` | {n} autre groupe | {n} other group |
| `at_ghost_sub` | sans privilège | no privilege |
| `at_ghost_text` | Ces groupes ne mènent à aucun des tiers analysés. Cochez « Masquer non-privilégiés » pour alléger l'arbre. | These groups lead to none of the analysed tiers. Tick "Hide unprivileged" to lighten the tree. |
| `at_ghost_title_many` | {n} groupes sans privilège | {n} groups with no privilege |
| `at_ghost_title_one` | {n} groupe sans privilège | {n} group with no privilege |
| `at_gpmc_delegation` | Dans la console de gestion des stratégies de groupe, ouvrez {gpo}, onglet Délégation, et retirez {holder}. | In the Group Policy Management Console, open {gpo}, Delegation tab, and remove {holder}. |
| `at_gpmc_local_users` | Dans la console de gestion des stratégies de groupe, modifiez {gpo} : Configuration ordinateur › Préférences › Paramètres du Panneau de configuration › Utilisateurs et groupes locaux, puis retirez {holder} du groupe {group}. | In the Group Policy Management Console, edit {gpo}: Computer Configuration › Preferences › Control Panel Settings › Local Users and Groups, then remove {holder} from the {group} group. |
| `at_gpmc_restricted` | Dans la console de gestion des stratégies de groupe, modifiez {gpo} : Configuration ordinateur › Stratégies › Paramètres Windows › Paramètres de sécurité › Groupes restreints, puis retirez {holder} du groupe {group}. | In the Group Policy Management Console, edit {gpo}: Computer Configuration › Policies › Windows Settings › Security Settings › Restricted Groups, then remove {holder} from the {group} group. |
| `at_group_desc` | Ses membres atteignent le Tier {tier}. | Its members reach Tier {tier}. |
| `at_help_group` | Groupe : SID d’un groupe, appartenance directe, imbriquée ou par groupe principal. | Group: SID of a group, direct, nested or primary-group membership. |
| `at_help_name` | Nom : motif sur le sAMAccountName, * pour une suite de caractères, ? pour un seul. | Name: pattern on the sAMAccountName, * for any run of characters, ? for a single one. |
| `at_help_ou` | OU : le DN du compte se termine par ce motif, sans tenir compte de la casse. | OU: the account's DN ends with this pattern, case-insensitive. |
| `at_hide_ghost` | Masquer non-privilégiés | Hide unprivileged |
| `at_inv_crumb` | Arbre inversé · Tier {tier} · {tn} | Inverted tree · Tier {tier} · {tn} |
| `at_inv_direct_title` | Droits directs · {sam} | Direct rights · {sam} |
| `at_inv_link_0` | Arbre inversé du Tier 0 › | Inverted tree of Tier 0 › |
| `at_inv_link_1` | Arbre inversé du Tier 1 › | Inverted tree of Tier 1 › |
| `at_inv_sum_acc_many` | {sam} est prévu en Tier {planned} et atteint le Tier {tier} par {n} chemins. | {sam} is planned as Tier {planned} and reaches Tier {tier} through {n} paths. |
| `at_inv_sum_acc_one` | {sam} est prévu en Tier {planned} et atteint le Tier {tier} par {n} chemin. | {sam} is planned as Tier {planned} and reaches Tier {tier} through {n} path. |
| `at_inv_sum_counts` | Groupes : {g} · mécanismes : {m}. | Groups: {g} · mechanisms: {m}. |
| `at_inv_sum_gap_many` | {n} comptes atteignent le Tier {tier} hors de leur tier prévu. | {n} accounts reach Tier {tier} outside their planned tier. |
| `at_inv_sum_gap_one` | {n} compte atteint le Tier {tier} hors de son tier prévu. | {n} account reaches Tier {tier} outside its planned tier. |
| `at_inv_sum_group_many` | {n} comptes analysés passent par là pour atteindre le Tier {tier}. | {n} analysed accounts go through here to reach Tier {tier}. |
| `at_inv_sum_group_one` | {n} compte analysé passe par là pour atteindre le Tier {tier}. | {n} analysed account goes through here to reach Tier {tier}. |
| `at_inv_sum_many` | {n} comptes atteignent le Tier {tier}. | {n} accounts reach Tier {tier}. |
| `at_inv_sum_mech_many` | {n} comptes analysés en profitent. | {n} analysed accounts benefit from it. |
| `at_inv_sum_mech_one` | {n} compte analysé en profite. | {n} analysed account benefits from it. |
| `at_inv_sum_one` | {n} compte atteint le Tier {tier}. | {n} account reaches Tier {tier}. |
| `at_inv_title` | Qui atteint le Tier {tier} ? | Who reaches Tier {tier}? |
| `at_inverse` | Arbre inversé | Inverted tree |
| `at_inverse_back` | Retour au compte | Back to the account |
| `at_kind_group` | Groupe | Group |
| `at_kind_group_ph` | SID du groupe | SID of the group |
| `at_kind_name` | Nom | Name |
| `at_kind_name_ph` | *-adm | *-adm |
| `at_kind_ou` | OU | OU |
| `at_kind_ou_ph` | OU=Admins-T0,DC=corp,DC=local | OU=Admins-T0,DC=corp,DC=local |
| `at_kpi_accounts` | Comptes à privilèges | Privileged accounts |
| `at_kpi_accounts_note` | sur {domain} | on {domain} |
| `at_kpi_gaps` | Écarts de tiering | Tiering gaps |
| `at_kpi_gaps_note` | {pct} % des comptes à privilèges | {pct} % of privileged accounts |
| `at_kpi_points` | Points de passage | Chokepoints |
| `at_kpi_points_note` | groupes ou droits à corriger | groups or rights to fix |
| `at_kpi_t0` | Tier 0 hors prévu | Unplanned Tier 0 |
| `at_kpi_t0_note` | comptes qui contrôlent le domaine | accounts that control the domain |
| `at_left_gaps` | Écarts de tiering · {n} | Tiering gaps · {n} |
| `at_left_label` | Comptes | Accounts |
| `at_left_less` | Réduire la liste | Shorten the list |
| `at_left_more` | Voir les {n} écarts › | See the {n} gaps › |
| `at_left_nomatch` | Aucun compte ne correspond à ces critères. | No account matches these criteria. |
| `at_left_none` | Aucun compte à afficher pour {domain}. | No account to show for {domain}. |
| `at_left_ok` | Conformes · {n} | Compliant · {n} |
| `at_legend_acl` | Délégation ACL | ACL delegation |
| `at_legend_gpo` | GPO | GPO |
| `at_legend_member` | Appartenance | Membership |
| `at_legend_other` | Autre chemin | Other path |
| `at_legend_selected` | Chemin sélectionné | Selected path |
| `at_lg_admins` | Administrateurs | Administrators |
| `at_lg_rdp` | Utilisateurs du Bureau à distance | Remote Desktop Users |
| `at_lg_winrm` | Utilisateurs de gestion à distance | Remote Management Users |
| `at_lh_account` | Compte | Account |
| `at_lh_gap` | Écart | Gap |
| `at_lh_group` | Groupe | Group |
| `at_lh_mech` | Mécanisme | Mechanism |
| `at_lh_mech_via` | Mécanisme · via | Mechanism · via |
| `at_lh_rel` | Relation | Relation |
| `at_lh_tier` | Tier atteint | Tier reached |
| `at_limits_text` | Les filtres de sécurité et les filtres WMI des GPO ne sont pas évalués, et les ACE de refus ne sont pas soustraites. Le tier atteint peut donc être surévalué, jamais sous-évalué. | GPO security filters and WMI filters are not evaluated, and deny ACEs are not subtracted. The tier reached can therefore be overestimated, never underestimated. |
| `at_limits_title` | Limites de l'analyse | Limits of the analysis |
| `at_list_empty` | Aucun chemin à afficher avec ces filtres. | No path to show with these filters. |
| `at_list_via` | via {group} | via {group} |
| `at_loading` | Chargement de l’arbre des comptes… | Loading the account tree… |
| `at_mech_gpo_edit` | Modification de GPO | GPO edit |
| `at_mech_sub_gpo` | GPO {gpo} | GPO {gpo} |
| `at_mech_sub_group` | groupe Tier {tier} | Tier {tier} group |
| `at_mech_sub_on` | sur {target} | on {target} |
| `at_members_many` | {n} membres | {n} members |
| `at_members_one` | {n} membre | {n} member |
| `at_meta` | Comptes à privilèges : {n} · écarts de tiering : {g} · {domain} · analyse du {date} | Privileged accounts: {n} · tiering gaps: {g} · {domain} · analysed on {date} |
| `at_meta_none` | Aucune analyse affichable · {domain} | No analysis to show · {domain} |
| `at_minimap` | Mini-carte : cliquer pour centrer la vue à cet endroit | Mini-map: click to centre the view there |
| `at_mx_aria_many` | {n} comptes prévus en Tier {p} et effectifs en Tier {e} | {n} accounts planned as Tier {p} and effective Tier {e} |
| `at_mx_aria_one` | {n} compte prévu en Tier {p} et effectif en Tier {e} | {n} account planned as Tier {p} and effective Tier {e} |
| `at_mx_effective` | Effectif T{tier} | Effective T{tier} |
| `at_mx_hint` | Cliquez une case pour filtrer la liste des comptes. | Click a cell to filter the account list. |
| `at_mx_planned` | Prévu T{tier} | Planned T{tier} |
| `at_mx_title` | Tier prévu et tier effectif | Planned tier and effective tier |
| `at_mx_uncollected` | La case Prévu T2 · Effectif T2 compte aussi {n} comptes sans privilège que l’analyse ne détaille pas. | The Planned T2 · Effective T2 cell also counts {n} unprivileged accounts the analysis does not detail. |
| `at_node_acc_sub` | {sam} · prévu T{planned} | {sam} · planned T{planned} |
| `at_node_svc_sub` | service · prévu T{planned} | service · planned T{planned} |
| `at_none` | aucun | none |
| `at_noscan_text` | Lancez une analyse pour construire l'arbre des comptes de ce domaine. Elle lit l'annuaire en lecture seule depuis le serveur Aegis. | Run an analysis to build the account tree of this domain. It reads the directory, read-only, from the Aegis server. |
| `at_noscan_title` | Aucune analyse pour {domain} | No analysis for {domain} |
| `at_override_open` | Corriger le tier prévu | Correct the planned tier |
| `at_override_reason` | Motif (obligatoire) | Reason (required) |
| `at_override_remove` | Retirer la correction | Remove the correction |
| `at_override_removed` | Correction retirée : le tier prévu revient aux règles. | Correction removed: the planned tier comes from the rules again. |
| `at_override_save` | Enregistrer la correction | Save the correction |
| `at_override_saved` | Tier prévu corrigé : les écarts sont recalculés. | Planned tier corrected: the gaps are recomputed. |
| `at_override_shown_at` | Corrigé le {date} | Corrected on {date} |
| `at_override_shown_by` | Corrigé par {author} | Corrected by {author} |
| `at_override_shown_by_at` | Corrigé par {author}, le {date} | Corrected by {author}, on {date} |
| `at_override_shown_label` | Motif de la correction | Reason for the correction |
| `at_override_tier` | Tier prévu corrigé | Corrected planned tier |
| `at_panel_label` | Détail de la sélection | Selection detail |
| `at_panel_pick` | Sélectionnez un compte pour afficher ses chemins de privilège. | Select an account to show its privilege paths. |
| `at_path_title` | {i} · {rel} | {i} · {rel} |
| `at_paths_label` | Chemins · {n} | Paths · {n} |
| `at_paths_more_many` | + {n} autres chemins : la vue Liste les montre tous. | + {n} other paths: the List view shows them all. |
| `at_paths_more_one` | + {n} autre chemin : la vue Liste les montre tous. | + {n} other path: the List view shows them all. |
| `at_pick_title` | Aucun compte sélectionné | No account selected |
| `at_planned_label` | Tier prévu | Planned tier |
| `at_point_acl` | {right} sur {target} | {right} on {target} |
| `at_point_expo_all` | tous les comptes | every account |
| `at_point_expo_many` | {n} comptes en écart | {n} accounts in gap |
| `at_point_expo_one` | {n} compte en écart | {n} account in gap |
| `at_point_gpo_edit` | Modification de {gpo} | Edit of {gpo} |
| `at_point_gpo_local` | {group} via {gpo} | {group} via {gpo} |
| `at_point_meta_broad` | Titulaire trop large : {holder} couvre tous les comptes | Holder too broad: {holder} covers every account |
| `at_point_meta_group` | Groupe · Tier {tier} | Group · Tier {tier} |
| `at_point_meta_holder` | Titulaire : {holder} | Holder: {holder} |
| `at_point_meta_t0` | Groupe Tier 0 · membre non prévu | Tier 0 group · unplanned member |
| `at_points_empty` | Aucun groupe ni droit ne fait sortir un compte de son tier prévu. | No group or right takes an account out of its planned tier. |
| `at_points_hint` | Groupes et droits qui font sortir des comptes de leur tier prévu. Corriger en haut de liste rapporte le plus. | Groups and rights that take accounts out of their planned tier. Fixing the top of the list pays off most. |
| `at_points_less` | Réduire | Shorten |
| `at_points_more` | Voir les {n} points de passage › | See the {n} chokepoints › |
| `at_points_title` | Points de passage | Chokepoints |
| `at_refs` | Référentiels | References |
| `at_rel_acl` | Délégation ACL | ACL delegation |
| `at_rel_gpo` | GPO | GPO |
| `at_rel_member` | Appartenance | Membership |
| `at_rel_nested` | Appartenance imbriquée | Nested membership |
| `at_rel_primary` | Groupe principal | Primary group |
| `at_row_gap` | {sam} · prévu T{planned} → T{effective} | {sam} · planned T{planned} → T{effective} |
| `at_row_gap_service` | compte de service · T{planned} → T{effective} | service account · T{planned} → T{effective} |
| `at_row_ok` | {sam} · Tier {effective} | {sam} · Tier {effective} |
| `at_rule_add` | Ajouter une règle | Add a rule |
| `at_rule_col_kind` | Type | Type |
| `at_rule_col_pattern` | Motif | Pattern |
| `at_rule_col_tier` | Tier | Tier |
| `at_rule_delete` | Supprimer la règle {n} | Delete rule {n} |
| `at_rule_down` | Descendre la règle {n} | Move rule {n} down |
| `at_rule_kind` | Type de la règle {n} | Type of rule {n} |
| `at_rule_pattern` | Motif de la règle {n} | Pattern of rule {n} |
| `at_rule_tier` | Tier de la règle {n} | Tier of rule {n} |
| `at_rule_up` | Monter la règle {n} | Move rule {n} up |
| `at_rules_button` | Règles de tiering | Tiering rules |
| `at_rules_meta` | La première règle qui correspond donne le tier prévu. Un compte qu’aucune règle ne couvre est Tier 2. | The first rule that matches gives the planned tier. An account no rule covers is Tier 2. |
| `at_rules_none` | Aucune règle : tous les comptes sont considérés Tier 2. | No rule: every account is treated as Tier 2. |
| `at_rules_save` | Enregistrer les règles | Save the rules |
| `at_rules_saved` | Règles enregistrées : les tiers prévus sont recalculés. | Rules saved: the planned tiers are recomputed. |
| `at_rules_tabs` | Paramètres | Settings |
| `at_rules_title` | Règles de tiering | Tiering rules |
| `at_scan` | Relancer l'analyse | Run the analysis again |
| `at_scan_done_many` | Analyse terminée : {n} écarts de tiering sur {domain}. | Analysis done: {n} tiering gaps on {domain}. |
| `at_scan_done_none` | Analyse terminée : aucun écart de tiering sur {domain}. | Analysis done: no tiering gap on {domain}. |
| `at_scan_done_one` | Analyse terminée : {n} écart de tiering sur {domain}. | Analysis done: {n} tiering gap on {domain}. |
| `at_scan_failed_toast` | Analyse échouée : {reason} | Analysis failed: {reason} |
| `at_scan_first` | Lancer la première analyse | Run the first analysis |
| `at_scanning` | Analyse en cours… | Analysis running… |
| `at_search_clear` | Effacer la recherche | Clear the search |
| `at_search_label` | Rechercher un compte | Search an account |
| `at_search_ph` | Nom ou sAMAccountName | Name or sAMAccountName |
| `at_set_domain` | Domaine analysé | Analysed domain |
| `at_set_domain_help` | Laissez vide pour analyser le domaine du serveur Aegis. | Leave empty to analyse the domain of the Aegis server. |
| `at_set_domain_ph` | corp.local | corp.local |
| `at_set_passes` | Nombre de passes | Number of passes |
| `at_set_passes_help` | Chaque passe suit les droits un niveau plus loin. De 1 à 5. | Each pass follows the rights one level further. From 1 to 5. |
| `at_set_save` | Enregistrer | Save |
| `at_set_saved` | Paramètres enregistrés : ils servent à la prochaine analyse. | Settings saved: the next analysis uses them. |
| `at_sev_below` | Sous le prévu | Below the plan |
| `at_sev_critical` | Critique | Critical |
| `at_sev_high` | Élevé | High |
| `at_sev_ok` | Conforme | Compliant |
| `at_source_default` | Aucune règle ne couvre ce compte : Tier 2 par défaut | No rule covers this account: Tier 2 by default |
| `at_source_override` | Correction manuelle | Manual correction |
| `at_source_rule` | Règle {n} : {pattern} | Rule {n}: {pattern} |
| `at_source_rule_unknown` | Règle de tiering | Tiering rule |
| `at_step_acl` | Retirer les droits de {holder} sur {target} | Remove the rights of {holder} on {target} |
| `at_step_gpo_edit` | Retirer {holder} de la délégation de la GPO {gpo} | Remove {holder} from the delegation of the GPO {gpo} |
| `at_step_gpo_local` | Retirer {holder} du groupe local {group} posé par la GPO {gpo} | Remove {holder} from the local group {group} set by the GPO {gpo} |
| `at_step_membership` | Retirer {member} du groupe {group} | Remove {member} from the group {group} |
| `at_step_other` | Couper le lien de {holder} vers {target} | Cut the link from {holder} to {target} |
| `at_step_primary` | Rendre à {member} son groupe principal par défaut | Give {member} its default primary group back |
| `at_sum_below` | {sam} est prévu en Tier {planned} mais n'atteint que le Tier {effective} : son tier prévu est peut-être trop haut. | {sam} is planned as Tier {planned} but only reaches Tier {effective}: its planned tier may be too high. |
| `at_sum_gap` | {sam} est prévu en Tier {planned} mais atteint le Tier {effective}. | {sam} is planned as Tier {planned} but reaches Tier {effective}. |
| `at_sum_mech_direct` | Droit accordé directement au compte, ce mécanisme donne le Tier {tier}. | A right granted directly to the account, this mechanism gives Tier {tier}. |
| `at_sum_mech_via` | Obtenu via {group}, ce mécanisme donne le Tier {tier}. | Obtained through {group}, this mechanism gives Tier {tier}. |
| `at_sum_ok` | {sam} reste dans le Tier {planned} prévu pour lui. | {sam} stays within the Tier {planned} planned for it. |
| `at_sum_tier_gap_many` | Prévu en Tier {planned}, ce compte obtient {gain} par {n} chemins. | Planned as Tier {planned}, this account gets {gain} through {n} paths. |
| `at_sum_tier_gap_one` | Prévu en Tier {planned}, ce compte obtient {gain} par {n} chemin. | Planned as Tier {planned}, this account gets {gain} through {n} path. |
| `at_sum_tier_ok_many` | Tier {tier} est le niveau prévu pour ce compte : {n} chemins y mènent, sans écart. | Tier {tier} is the level planned for this account: {n} paths lead to it, with no gap. |
| `at_sum_tier_ok_one` | Tier {tier} est le niveau prévu pour ce compte : {n} chemin y mène, sans écart. | Tier {tier} is the level planned for this account: {n} path leads to it, with no gap. |
| `at_sum_tier_under` | Tier {tier} est au-dessous du Tier {planned} prévu pour ce compte : ces chemins ne créent pas d'écart. | Tier {tier} is below the Tier {planned} planned for this account: these paths create no gap. |
| `at_tab_rules` | Règles | Rules |
| `at_tab_scan` | Analyse | Analysis |
| `at_tier_n` | Tier {tier} | Tier {tier} |
| `at_tier_node` | Tier {tier} · {name} | Tier {tier} · {name} |
| `at_title` | Arbre des comptes | Account tree |
| `at_tn_0` | domaine | domain |
| `at_tn_1` | serveurs | servers |
| `at_tn_2` | postes | workstations |
| `at_tree_nogap_text` | Ce compte reste dans son tier prévu. Décochez « Écarts seulement » pour voir tous ses chemins. | This account stays within its planned tier. Untick "Gaps only" to see all its paths. |
| `at_tree_nogap_title` | Aucun chemin en écart | No path in gap |
| `at_tree_none_text` | Ce compte n'atteint aucun groupe ni droit relevé par l'analyse : il reste en Tier 2. | This account reaches no group or right the analysis records: it stays Tier 2. |
| `at_tree_none_title` | Aucun chemin de privilège | No privilege path |
| `at_view_group` | Affichage | View |
| `at_view_list` | Liste | List |
| `at_view_overview` | Vue d'ensemble | Overview |
| `at_view_tree` | Arbre | Tree |
| `at_warn_primary_group` | Remove-ADGroupMember ne retire pas un groupe principal : la commande remet le groupe par défaut (513, ou 515 pour un ordinateur ou un gMSA). | Remove-ADGroupMember does not remove a primary group: the command sets the default group back (513, or 515 for a computer or a gMSA). |
| `at_warn_removes_all_aces` | dsacls /R retire toutes les ACE de ce titulaire sur l’objet, pas seulement celle-ci : relevez les autres avant de lancer la commande. | dsacls /R removes every ACE of this holder on the object, not only this one: note the others before running the command. |
| `at_why_acl` | {holder} détient {right} sur {target}, ce qui donne le Tier {tier}. | {holder} holds {right} on {target}, which gives Tier {tier}. |
| `at_why_acl_inherited` | {holder} détient {right} sur {target}, hérité de {origin}, ce qui donne le Tier {tier}. | {holder} holds {right} on {target}, inherited from {origin}, which gives Tier {tier}. |
| `at_why_dcsync` | {holder} peut répliquer les secrets du domaine {target} (DCSync), ce qui donne le Tier {tier}. | {holder} can replicate the secrets of the domain {target} (DCSync), which gives Tier {tier}. |
| `at_why_gpo_edit` | {holder} peut modifier la GPO {gpo}, appliquée à des machines Tier {tier}. | {holder} can edit the GPO {gpo}, applied to Tier {tier} machines. |
| `at_why_gpo_local` | La GPO {gpo} place {holder} dans le groupe local {group} de machines Tier {tier}. | The GPO {gpo} puts {holder} in the local group {group} of Tier {tier} machines. |
| `at_why_member` | {holder} est membre de {target}, un groupe Tier {tier}. | {holder} is a member of {target}, a Tier {tier} group. |
| `at_why_member_nested` | Par appartenance imbriquée, {account} hérite de {target}, un groupe Tier {tier}. | Through nested membership, {account} inherits {target}, a Tier {tier} group. |
| `at_why_primary` | {target} est le groupe principal de {holder} : il ne figure pas dans memberOf, mais il donne le Tier {tier}. | {target} is the primary group of {holder}: it is absent from memberOf, yet it gives Tier {tier}. |
| `at_why_title` | Pourquoi Tier {tier} ? | Why Tier {tier}? |
| `at_wk_anonymous` | Ouverture de session anonyme | Anonymous Logon |
| `at_wk_authenticated` | Utilisateurs authentifiés | Authenticated Users |
| `at_wk_domain_computers` | Ordinateurs du domaine | Domain Computers |
| `at_wk_domain_users` | Utilisateurs du domaine | Domain Users |
| `at_wk_everyone` | Tout le monde | Everyone |
| `at_wk_pre2000` | Accès compatible pré-Windows 2000 | Pre-Windows 2000 Compatible Access |
| `at_zoom_in` | Zoomer | Zoom in |
| `at_zoom_out` | Dézoomer | Zoom out |
| `at_zoom_pct` | {n} % | {n} % |
