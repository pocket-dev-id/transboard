 'use strict';
const { activeStatuses } = require('../js/transfer-workflow');
function jsonSetting(db, id, fallback) {
  try { return JSON.parse((db.system_settings || []).find(s => s.id === id)?.value || 'null') ?? fallback; } catch { return fallback; }
}
function planPatientImport(rows, db) {
  if (!Array.isArray(rows) || rows.length > 100000) throw Error('取込行数を確認してください');
  const policy = jsonSetting(db, 'import_retention_policy', {});
  let mode = policy.mode || (policy.clearUnlisted ? 'snapshot' : 'delta');
  const scope = new Set((Array.isArray(policy.scopeWardIds) ? policy.scopeWardIds : []).map(String));
  if ([...scope].some(id => !(db.wards || []).some(w => String(w.id) === id))) throw Error('対象病棟の設定を確認してください');
  let warning = '';
  if (mode === 'snapshot' && scope.size === 0) {
    if (policy.mode === 'snapshot') throw Error('全件取込には対象病棟の指定が必要です');
    // 旧バージョンには病棟範囲の保存欄がない。旧設定は患者更新を継続し、
    // 病棟範囲が確認されるまでは空床化だけを保留する。
    mode = 'delta';
    warning = '旧全件取込設定には対象病棟がありません。差分更新のみ実行しました。設定で対象病棟を選択してください。';
  }
  const scopedBeds = (db.beds || []).filter(b => scope.size === 0 || scope.has(String(b.ward_id)));
  const admMode = (db.system_settings || []).find(s => s.id === 'admission_mode')?.value || 'csv';
  const activeBedIds = new Set((db.transfer_events || []).filter(e => activeStatuses.includes(e.current_status)).map(e => e.bed_id));
  const hasOccupant = rec => Boolean(rec && (rec.patient_id || rec.patient_name));
  const isSameOccupant = (before, after) => {
    if (!hasOccupant(before) || !hasOccupant(after)) return false;
    if (before.patient_id && after.patient_id) return String(before.patient_id) === String(after.patient_id);
    return String(before.patient_name || '') === String(after.patient_name || '');
  };
  let importedCount = 0, skipCount = 0, clearCount = 0;
  const overwrittenActiveBeds = [];
        // カラムマッピングのロード
        let mapping = { bed_number: '', patient_id: '', patient_name: '', is_present: '' };
        const mappingSetting = db.system_settings?.find(s => s.id === 'import_mapping');
        if (mappingSetting && mappingSetting.value) {
          try {
            mapping = JSON.parse(mappingSetting.value);
          } catch (e) {
            console.error('[Import] マッピング設定のパース失敗:', e);
          }
        }

        // Default import mapping. Also auto-detect common Japanese EMR CSV headers.
        const sampleRow = rows.find(row => row && Object.keys(row).length > 0) || {};
        const pickColumn = (...names) => names.find(name => Object.prototype.hasOwnProperty.call(sampleRow, name)) || '';
        const mapBed = mapping.bed_number || pickColumn('bed_number', '\u75c5\u5e8a\u756a\u53f7') || 'bed_number';
        const mapRoomCode = mapping.room_code || pickColumn('room_code', '\u75c5\u5ba4\u30b3\u30fc\u30c9');
        const mapBedCode = mapping.bed_code || pickColumn('bed_code', '\u75c5\u5e8a\u30b3\u30fc\u30c9');
        const joinChar = mapping.join_char !== undefined ? mapping.join_char : '-';

        const mapPatId = mapping.patient_id || pickColumn('patient_id', '\u60a3\u8005ID') || 'patient_id';
        const mapPatName = mapping.patient_name || pickColumn('patient_name', '\u6f22\u5b57\u6c0f\u540d', '\u60a3\u8005\u6c0f\u540d', '\u6c0f\u540d') || 'patient_name';
        const mapPresent = mapping.is_present || pickColumn('is_present');

        const bulkUpdates = [];
        const listedBedIds = new Set();
        const seenImportedBedIds = new Set();
        for (const row of rows) {
          try {
            // 1. Resolve the target bed from either a combined bed number or room/bed codes.
            let bedNoVal = '';
            let bedCandidates = [];
            let roomVal = '';
            let bedVal = '';
            
            const isCombined = Boolean(mapping.room_code && mapping.bed_code);
            if (isCombined) {
              roomVal = (row[mapRoomCode] || '').trim();
              bedVal = (row[mapBedCode] || '').trim();
              if (roomVal && bedVal) {
                bedNoVal = `${roomVal}${joinChar}${bedVal}`;
                bedCandidates = [
                  `${roomVal}${joinChar}${bedVal}`,
                  `${roomVal}${bedVal}`,
                  `${roomVal}_${bedVal}`,
                  `${roomVal}/${bedVal}`,
                  `${roomVal} ${bedVal}`
                ];
              } else {
                bedNoVal = roomVal || bedVal;
                bedCandidates = [bedNoVal];
              }
            } else {
              bedNoVal = (row[mapBed] || '').trim();
              bedCandidates = [bedNoVal];
            }

            if (!bedNoVal) {
              skipCount++;
              continue;
            }

            const normalizedCandidates = new Set(bedCandidates.filter(Boolean).map(v => String(v).trim()));
            const matches = scopedBeds.filter(b => {
              const bedNumber = String(b.bed_number || '').trim();
              if (normalizedCandidates.has(bedNumber)) return true;

              if (roomVal && bedVal) {
                const masterRoom = String(b.room_code || b.room_number || '').trim();
                const masterBedCode = String(b.bed_code || '').trim();
                if (masterRoom === roomVal && masterBedCode === bedVal) return true;
                if (masterRoom === roomVal && bedNumber === bedVal) return true;
              }

              return false;
            });
            const bed = matches.length === 1 ? matches[0] : null;
            if (!bed) {
              console.warn(`[Import] 該当する病床が見つかりません: ${bedNoVal}`);
              skipCount++;
              continue;
            }

            // 同じ病床がCSVに複数行ある場合は、最後の行だけを暗黙に採用せず安全側に倒す。
            if (seenImportedBedIds.has(bed.id)) {
              console.warn(`[Import] 同一病床の重複行をスキップしました: ${bedNoVal}`);
              skipCount++;
              continue;
            }

            // ハイブリッド運用では、手動登録した病床の患者情報をCSVで上書きしない。
            // 未掲載病床のクリア対象からも除外するため listed に記録する。
            if (admMode === 'hybrid' && bed.manually_registered) {
              listedBedIds.add(bed.id);
              console.warn(`[Import] 手動登録病床をCSV更新から保護しました: ${bedNoVal}`);
              skipCount++;
              continue;
            }

            // 2. Update patient information.
            const patientName = (row[mapPatName] || '').trim();
            const patientId = (row[mapPatId] || '').trim();
            const isPresentValue = mapPresent ? (row[mapPresent] || '').trim() : '';
            const hasPatient = Boolean(patientName || patientId);
            const emptyBedLabel = '\u7a7a\u5e8a';
            
            const isPresent = mapPresent
              ? ['\u3044\u308b', '\u5728\u5e8a', '1', 'true', 'yes', 'y'].includes(isPresentValue.toLowerCase())
              : hasPatient;

            const patch = {
              id: bed.id,
              patient_name: hasPatient && patientName !== emptyBedLabel ? patientName : null,
              patient_id: hasPatient && patientName !== emptyBedLabel ? patientId : null,
              is_present: hasPatient && patientName !== emptyBedLabel ? isPresent : false,
              _expectedUpdatedAt: Number(bed.updated_at || 0),
              _occupancySource: 'csv_import'
            };

            // 進行中の移送がある病床の患者が入れ替わる場合、移送イベント側は登録時の
            // 患者名スナップショットを持ち続けるため、帰棟までダッシュボードと移送情報で
            // 別々の患者が表示される。電子カルテを正として上書き自体は続けるが、
            // 気づかないまま進まないよう取り込み後に警告する。
            if (activeBedIds.has(bed.id) && !isSameOccupant(bed, patch)) {
              overwrittenActiveBeds.push(bed.bed_number || bed.id);
            }

            seenImportedBedIds.add(bed.id);
            listedBedIds.add(bed.id);
            bulkUpdates.push(patch);
            importedCount++;
          } catch (err) {
            console.error('[Import] エラー発生:', err);
            skipCount++;
          }
        }


  if (listedBedIds.size === 0) throw Error('有効な病床データがありません。原本を残します');
  if (mode === 'snapshot' && policy.clearUnlisted) {
    const matchPercent = 100 * listedBedIds.size / rows.length;
    const minMatchPercent = Number.isFinite(Number(policy.minMatchPercent)) ? Math.max(95, Math.min(100, Number(policy.minMatchPercent))) : 95;
    if (matchPercent < minMatchPercent) throw Error('病床の一致率が低いため全件取込を中止しました');
    const occupied = scopedBeds.filter(b => hasOccupant(b));
    const cleared = occupied.filter(b => !listedBedIds.has(b.id) && !activeBedIds.has(b.id) && !(admMode === 'hybrid' && b.manually_registered));
    const maxClearPercent = Number.isFinite(Number(policy.maxClearPercent)) ? Math.max(0, Math.min(100, Number(policy.maxClearPercent))) : 25;
    if (occupied.length && cleared.length * 100 / occupied.length > maxClearPercent) throw Error('患者情報の減少が上限を超えるため全件取込を中止しました');
    for (const bed of cleared) {
      bulkUpdates.push({ id: bed.id, patient_name: null, patient_id: null, is_present: false, _expectedUpdatedAt: Number(bed.updated_at || 0), _occupancySource: 'csv_clear' });
      clearCount++;
    }
  }
  return { updates: bulkUpdates, importedCount, skipCount, clearCount, overwrittenActiveBeds, warning };
}
module.exports = { planPatientImport };
