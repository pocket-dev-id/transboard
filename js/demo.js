/**
 * 検査室の電話番号と病床マップ位置が空のときの補完。
 * デモ移送の自動投入は行わない。
 */

const DemoData = {
  async setup() {
    try {
      await this._ensureExamRoomPhones();
      await this._ensureBedMapPositions();
    } catch (e) {
      console.error('[Demo] マスタ補完に失敗:', e);
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
};
