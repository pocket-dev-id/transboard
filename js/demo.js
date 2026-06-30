/**
 * デモデータ投入スクリプト
 * ページ初回ロード時に既存イベントがない場合のみ投入
 */

const DemoData = {

  async setup() {
    try {
      // 検査室の電話番号を設定（なければ更新）
      await this._ensureExamRoomPhones();

      // 病床の map_col/map_row を設定（なければ更新）
      await this._ensureBedMapPositions();

      // すでにデモデータ投入フラグが立っているかチェック
      let isDemoInserted = false;
      try {
        const settingsRes = await API.getAll('system_settings');
        const demoSetting = settingsRes.data?.find(s => s.id === 'demo_inserted');
        if (demoSetting && demoSetting.value === 'true') {
          isDemoInserted = true;
        }
      } catch (e) {
        console.warn('[Demo] 設定の取得に失敗:', e);
      }

      if (isDemoInserted) {
        console.log('[Demo] デモデータ投入済みフラグ(true)のため、スキップ');
        return;
      }

      const existing = await API.getAllEventsForWard('ward-1');
      if (existing.length > 0) {
        console.log('[Demo] 既存データあり、スキップ');
        return;
      }
      console.log('[Demo] デモデータ投入...');
      await this._insertDemoEvents();

      // デモデータ投入完了フラグを設定
      try {
        await API.patch('system_settings', 'demo_inserted', { value: 'true' });
      } catch (e) {
        console.warn('[Demo] フラグ更新に失敗:', e);
      }

      console.log('[Demo] 完了');
    } catch (e) {
      console.error('[Demo] 投入失敗:', e);
    }
  },

  async _ensureExamRoomPhones() {
    // 検査室マスタに電話番号が入っていなければ設定
    const phoneMap = {
      'room-ct':   { phone: '2001', note: 'CT室 内線' },
      'room-mri':  { phone: '2002', note: 'MRI室 内線' },
      'room-xp':   { phone: '2010', note: 'X線室 内線' },
      'room-endo': { phone: '2030', note: '内視鏡室 内線' },
      'room-echo': { phone: '2020', note: 'エコー室 内線' },
    };
    const rooms = await API.getExamRooms();
    for (const room of rooms) {
      if (!room.phone && phoneMap[room.id]) {
        await API.patch('exam_rooms', room.id, phoneMap[room.id]);
      }
    }

    // 病棟電話番号も設定
    const wards = await API.getWards();
    const wardPhoneMap = {
      'ward-1': { phone: '7101', note: '7階東 ナースステーション' },
      'ward-2': { phone: '7201', note: '7階西 ナースステーション' },
    };
    for (const ward of wards) {
      if (!ward.phone && wardPhoneMap[ward.id]) {
        await API.patch('wards', ward.id, wardPhoneMap[ward.id]);
      }
    }
  },

  async _ensureBedMapPositions() {
    // 病床の map_col/map_row が未設定なら初期配置を設定
    // 7階東病棟 標準レイアウト:
    // 行0: 701 702 [廊下] 703 704 [廊下] 705 706
    // 行1: 707 708 [廊下] 709 710 [廊下] 711 712
    // 行2: 713 714 [廊下] 715 716 [廊下] 717 718(個室)
    const layoutMap = {
      'bed-701': { map_col: 0, map_row: 0, room_number: '701', sort_order: 1 },
      'bed-702': { map_col: 1, map_row: 0, room_number: '701', sort_order: 2 },
      'bed-703': { map_col: 3, map_row: 0, room_number: '702', sort_order: 3 },
      'bed-704': { map_col: 4, map_row: 0, room_number: '702', sort_order: 4 },
      'bed-705': { map_col: 6, map_row: 0, room_number: '703', sort_order: 5 },
      'bed-706': { map_col: 7, map_row: 0, room_number: '703', sort_order: 6 },
      'bed-707': { map_col: 0, map_row: 2, room_number: '704', sort_order: 7 },
      'bed-708': { map_col: 1, map_row: 2, room_number: '704', sort_order: 8 },
      'bed-709': { map_col: 3, map_row: 2, room_number: '705', sort_order: 9 },
      'bed-710': { map_col: 4, map_row: 2, room_number: '705', sort_order: 10 },
      'bed-711': { map_col: 6, map_row: 2, room_number: '706', sort_order: 11 },
      'bed-712': { map_col: 7, map_row: 2, room_number: '706', sort_order: 12 },
      'bed-713': { map_col: 0, map_row: 4, room_number: '707', sort_order: 13 },
      'bed-714': { map_col: 1, map_row: 4, room_number: '707', sort_order: 14 },
      'bed-715': { map_col: 3, map_row: 4, room_number: '708', sort_order: 15 },
      'bed-716': { map_col: 4, map_row: 4, room_number: '708', sort_order: 16 },
      'bed-717': { map_col: 6, map_row: 4, room_number: '709個室', sort_order: 17 },
      'bed-718': { map_col: 7, map_row: 4, room_number: '709個室', sort_order: 18 },
    };
    const beds = (await API.getAll('beds')).data;
    for (const bed of beds) {
      if ((bed.map_col === undefined || bed.map_col === null) && layoutMap[bed.id]) {
        await API.patch('beds', bed.id, layoutMap[bed.id]);
      }
    }
  },

  async _insertDemoEvents() {
    const now = Date.now();
    const min = 60 * 1000;

    const events = [
      // 701: 検査中（CT、30分前出棟）
      {
        id: `demo-evt-701`,
        bed_id: 'bed-701',
        ward_id: 'ward-1',
        exam_type_id: 'exam-ct',
        exam_room_id: 'room-ct',
        escort_staff_id: 'staff-2',
        current_status: 'IN_EXAM',
        expected_duration_min: 30,
        departed_at: now - 35 * min,
        arrived_at: now - 30 * min,
        exam_started_at: now - 25 * min,
        nearly_done_at: null,
        pickup_ready_at: null,
        returned_at: null,
        estimated_pickup_at: now + 5 * min,
        note: '車椅子使用',
      },
      // 703: あと10分（MRI）
      {
        id: `demo-evt-703`,
        bed_id: 'bed-703',
        ward_id: 'ward-1',
        exam_type_id: 'exam-mri',
        exam_room_id: 'room-mri',
        escort_staff_id: 'staff-3',
        current_status: 'NEARLY_DONE',
        expected_duration_min: 60,
        departed_at: now - 65 * min,
        arrived_at: now - 60 * min,
        exam_started_at: now - 55 * min,
        nearly_done_at: now - 2 * min,
        pickup_ready_at: null,
        returned_at: null,
        estimated_pickup_at: now + 8 * min,
        note: '',
      },
      // 705: 迎え要（XP）
      {
        id: `demo-evt-705`,
        bed_id: 'bed-705',
        ward_id: 'ward-1',
        exam_type_id: 'exam-xp',
        exam_room_id: 'room-xp',
        escort_staff_id: null,
        current_status: 'PICKUP_REQUIRED',
        expected_duration_min: 20,
        departed_at: now - 30 * min,
        arrived_at: now - 25 * min,
        exam_started_at: now - 20 * min,
        nearly_done_at: now - 12 * min,
        pickup_ready_at: now - 5 * min,
        returned_at: null,
        estimated_pickup_at: now - 5 * min,
        note: 'ストレッチャー使用',
      },
      // 707: 出棟登録済（内視鏡）
      {
        id: `demo-evt-707`,
        bed_id: 'bed-707',
        ward_id: 'ward-1',
        exam_type_id: 'exam-endo',
        exam_room_id: 'room-endo',
        escort_staff_id: 'staff-4',
        current_status: 'DEPART_REGISTERED',
        expected_duration_min: 90,
        departed_at: null,
        arrived_at: null,
        exam_started_at: null,
        nearly_done_at: null,
        pickup_ready_at: null,
        returned_at: null,
        estimated_pickup_at: now + 90 * min,
        note: '',
      },
      // 710: 移動中（エコー）
      {
        id: `demo-evt-710`,
        bed_id: 'bed-710',
        ward_id: 'ward-1',
        exam_type_id: 'exam-echo',
        exam_room_id: 'room-echo',
        escort_staff_id: 'staff-5',
        current_status: 'MOVING',
        expected_duration_min: 40,
        departed_at: now - 5 * min,
        arrived_at: null,
        exam_started_at: null,
        nearly_done_at: null,
        pickup_ready_at: null,
        returned_at: null,
        estimated_pickup_at: now + 35 * min,
        note: '',
      },
      // 712: 帰棟済（CT、1時間前）
      {
        id: `demo-evt-712`,
        bed_id: 'bed-712',
        ward_id: 'ward-1',
        exam_type_id: 'exam-ct',
        exam_room_id: 'room-ct',
        escort_staff_id: 'staff-6',
        current_status: 'RETURNED',
        expected_duration_min: 30,
        departed_at: now - 90 * min,
        arrived_at: now - 85 * min,
        exam_started_at: now - 80 * min,
        nearly_done_at: now - 60 * min,
        pickup_ready_at: now - 55 * min,
        returned_at: now - 50 * min,
        estimated_pickup_at: now - 60 * min,
        note: '',
      },
    ];

    for (const evt of events) {
      try {
        await API.createEvent(evt);
        await API.addStatusLog(evt.id, null, evt.current_status, 'demo');
      } catch (e) {
        console.warn('[Demo] イベント投入失敗:', evt.id, e.message);
      }
    }
  },
};
