#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Synchronize/check mechanically derived Markdown, never rewrite prose."""
import argparse, json, re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
DOC=ROOT/'host/sprinter/ultrags/docs/ULTRAGS-PROGRAMMING.md'
s=json.loads((ROOT/'tools/ultrags/wire-schema.json').read_text())
def table(headers,rows):
    clean=lambda x:str(x).replace('—','-').replace('–','-').replace('|','&#124;').replace('\n',' ')
    return '\n'.join(['| '+' | '.join(headers)+' |','|'+'---|'*len(headers)]+['| '+' | '.join(map(clean,r))+' |' for r in rows])+'\n'
def size(t):
    if t in ('u8','s8'): return 1
    if t in ('u16','s16'):return 2
    if t=='u32':return 4
    if t=='u64':return 8
    kind,arg=t.split(':',1)
    if kind=='struct':return s['structs'][arg]['size']
    if kind=='bytes':return int(arg)
    if kind in ('array','varray'):return 0
    raise ValueError(t)
NOTES = {
    '0=idle 1=playing 2=paused': '0=неактивен, 1=играет, 2=пауза',
    'actual allocated bytes rounded up to 16': 'Фактический резерв в байтах, округлён до 16',
    'bit0=VERIFY_OBJECT': 'Бит 0: проверить CRC всего объекта',
    'bit0=forward loop': 'Бит 0: петля вперёд',
    'bit0=legacy override, bit1=whole-object repeat': 'Бит 0: подмена канала GS; бит 1: повтор всего объекта',
    'VERIFIED only; +4 bytes -> 13': 'VERIFIED: полный размер 13 байт',
    'VERIFIED only; +4 bytes -> 8': 'VERIFIED: полный размер 8 байт',
}
# Behaviour checked against ug_storage.c, ug_legacy.inc and ug_minimal.c.
# This prose supplements schema fields; it does not change the protocol.
USAGE = {
'INFO': 'Определяет версию и состояние карты. До ALLOC/PLAY проверьте UGS1, API 1.0, VLS1 и boot_state=0; сохраните session. Лишние байты запроса дают BAD_OPCODE. Команда доступна даже при ошибке памяти.',
'CAPS': 'Возвращает доступные функции, форматы и пределы. Проверяйте нужные биты перед использованием функции. music_limit и fx_limit относятся к общему пулу и не складываются. Во время передачи блока возвращает BUSY.',
'MEM_INFO': 'Возвращает размеры памяти в байтах и число объектов. Для одного ALLOC нужен непрерывный участок largest. Не меняет память и не останавливает звук.',
'STATS': 'Читает 16 счётчиков u32. max_render_us и max_command_us измеряются в микросекундах; rx_high_water и tx_high_water - пиковое заполнение FIFO в байтах. Остальные поля считают операции, байты, блоки или отсчёты по имени. Для наблюдения за своим сценарием сравнивайте значения до и после него.',
'CLEAR_STATS': 'Обнуляет общую статистику. Звук и объекты сохраняются. Команда влияет и на измерения других наблюдателей; для обычного мониторинга предпочтительнее разность двух STATS.',
'MEM_TEST': 'mode=0: короткая проверка, mode=1: полная. Требует пустого хранилища; при занятых ресурсах BUSY. При ошибке PSRAM результат теста всё равно содержит tested, first_bad и expected/actual. На успехе first_bad=FFFFFFFFh.',
'RESET_STORE': 'Глобальное обслуживание с ключом 55475253h: level=0 очищает объекты и воспроизведение, level=1 дополнительно проверяет память. Возвращает новую session; все старые handles и IDs недействительны. Это не очистка отдельной программы. При незавершённой передаче или GS LOAD возможен BUSY.',
'ALLOC': 'Создаёт UPLOADING-объект kind=0 BLOB, 1 RAW, 2 WAV или 3 MOD. size задаётся в байтах, положительный. Сохраняйте возвращённый handle; reserve - фактический объём с округлением до 16. NO_MEMORY означает нехватку непрерывной памяти, NO_HANDLES - лимит объектов или номеров.',
'FREE': 'Удаляет указанный объект. Сначала остановите все собственные запуски, использующие его. PINNED означает, что объект ещё нужен проигрывателю или передаче; повтор допускается после ожидания. Неизвестный handle даёт HANDLE.',
'OBJECT_INFO': 'Читает метаданные объекта: state=0 загрузка, 1 готов, 2 испорчен; pins запрещает удаление. size и uploaded измеряются в байтах. Параметры звука имеют смысл после PCM_CONFIG или успешного разбора SEAL. Неизвестный объект даёт HANDLE.',
'SEAL': 'Проверяет полностью загруженный объект и переводит его в READY. Для RAW предварительно нужен PCM_CONFIG. flags=0 требует expected_crc=0; flags=1 проверяет CRC всего объекта. Успех возвращает actual_crc. STATE означает неподходящую фазу; FORMAT/CRC - неверное содержимое. Не повторяйте SEAL объекта READY.',
'PCM_CONFIG': 'Задаёт описание только RAW в состоянии UPLOADING, без pins. Вложенная структура PCM_DESC приведена в 9.8. Неправильные частота, формат, длина или петля дают FORMAT; другой kind или состояние - STATE.',
'OBJECT_ENUM': 'Обходит handles по возрастанию: первый запрос after_handle=0, следующий - с ранее возвращённым next_handle. Ноль в ответе завершает обход. Перечисление само по себе не доказывает, что объект принадлежит вызывающей программе.',
'LEGACY_INFO': 'Возвращает native handles текущих GS MOD, FX и незавершённой загрузки; 0 означает отсутствие. uploaded - число принятых байтов LOAD. Эти u16 handles отличаются от однобайтовых номеров GS.',
'WRITE_BEGIN': 'Начинает запись N=1..1024 байт. Для последовательной загрузки offset=uploaded; BLOB также допускает перезапись уже загруженного диапазона. transport=00h/01h FAST или 80h/81h VERIFIED. Сначала получите token и WRITE_GRANT, затем отправьте данные. STATE/RANGE означают неподходящую фазу или диапазон.',
'WRITE_END': 'Передаёт token после всех N байт. Только успешный END подтверждает запись. SHORT_TRANSFER означает недостачу данных, CRC - несовпадение в VERIFIED. После отказа блок не считается подтверждённым; сверяйте OBJECT_INFO перед продолжением.',
'READ_BEGIN': 'Начинает чтение N=1..1024 байт в пределах uploaded; объект может быть READY и играть. После token дождитесь READ_GRANT. В VERIFIED ответ дополнительно содержит CRC данных. Запрос CRC не содержит. RANGE означает чтение за доступной границей.',
'READ_END': 'Завершает чтение по token. В VERIFIED передайте вычисленную host_crc; в FAST поле отсутствует. Неверный token даёт HANDLE, неполное чтение - SHORT_TRANSFER, несовпадение CRC - CRC. Данные объекта не меняются.',
'TRANSFER_CANCEL': 'Отменяет передачу с данным token, освобождая её временный буфер и pin. Ранее завершённые блоки сохраняются. Неизвестный или уже завершённый token даёт HANDLE.',
'PLAY_PCM': 'Запускает READY RAW/WAV как основной звук. repeats=0 повторяет весь объект, 1 играет один раз, 2..65535 задаёт число проходов; внутренняя RAW-петля требует repeats=1. gain=0..64, pan=0..255. Возвращает play_id. При NO_VOICE/BUSY новый запуск не принят; прежний звук сохраняется.',
'PLAY_MOD': 'Запускает READY MOD с начала и возвращает play_id. flags: 1 LOOP, 2 IGNORE_F00, 4 PAUSE_F00; последние два несовместимы. Без них действует GS6A. Некорректные flags дают BAD_ARGUMENT, нехватка голосов - NO_VOICE, неподходящий объект - STATE/FORMAT.',
'CONTROL': 'Управляет основным звуком: action=0 STOP, 1 PAUSE, 2 RESUME. play_id=0 выбирает текущий запуск, поэтому для очистки используйте точный ID. RESUME требует паузы. Нет подходящего активного запуска - STATE. STOP не удаляет обычный объект, но закрывает поток.',
'SEEK_MOD': 'Переводит активный MOD на order и row=0..63. order меньше длины песни. play_id=0 означает текущий MOD; неверный ID или не MOD дают STATE, неверная позиция - RANGE. Эффекты и темп сбрасываются на 6/125, состояние паузы сохраняется.',
'SET_MIX': 'Четыре уровня 0..64: music_master, fx_master, music_gain, fx_gain. Изменяет общие уровни основного звука и FX, включая GS-эффекты; OPL2 не затрагивает. Значение выше 64 даёт BAD_ARGUMENT. Это общая настройка, без ID отдельного запуска.',
'SET_TEMPO': 'Меняет текущий MOD: speed=1..31 тиков на строку, BPM=32..255. Нет активного MOD - STATE, неверные значения - BAD_ARGUMENT. Последующие команды темпа внутри песни могут снова изменить значения.',
'PLAY_FX': 'Создаёт независимый запуск READY RAW/WAV. preferred_voice=FFFFh выбирает голоса автоматически, иначе 0..31. priority=1..254, gain=0..64, pan=0..255. flags: 1 разрешает вытеснять FX меньшего приоритета, 2 повторяет весь объект. Музыка не вытесняется; при NO_VOICE ни один канал эффекта не запускается.',
'STOP_FX': 'Останавливает instance_id эффекта, не удаляя его объект. ID=0 останавливает все native FX; для очистки одного приложения он не подходит. Несуществующий ненулевой ID даёт HANDLE. Музыку и GS direct FX команда не останавливает.',
'SET_PAN': 'Меняет панораму логического MOD-канала, а не физического голоса. channel должен существовать и быть 0..7 даже у MOD с большим числом каналов; иначе RANGE. pan=0..255. Нет активного MOD - STATE. Настройку могут заменить PLAY, SEEK и команды самого MOD.',
'CONTROL_FX': 'Управляет одним ненулевым instance_id: action=0 STOP, 1 PAUSE, 2 RESUME. При паузе голоса и позиция сохраняются. Нет такого FX - HANDLE, RESUME без паузы - STATE. Основной звук и другие FX продолжаются.',
'STREAM_CREATE': 'Создаёт единственное PCM-кольцо. rate=8000..48000, channels=1/2, bits=8/16, формат U8/S8/S16LE; reserved=0. Размеры в байтах, кратные размеру PCM-кадра; buffer>0, 0<prefill<=buffer, 0<=low<prefill. Второе кольцо даёт BUSY; неверные размеры - BAD_ARGUMENT, формат - FORMAT.',
'STREAM_STATE': 'Читает состояние своего кольца. fill/free - байты; published/consumed/position - PCM-кадры; fraction - дробная часть Q0.32. Сверяйте next_sequence после потери ответа FEED. После CLOSE объект исчезает и запрос даёт HANDLE.',
'STREAM_START': 'Однократно занимает основной звук и возвращает play_id. gain=0..64, pan=0..255. До prefill звучит тишина. Повторный START даёт STATE, нехватка голосов - NO_VOICE. Независимые FX сохраняются.',
'STREAM_FEED': 'Отправляет 1..1024 байта полных PCM-кадров; первый sequence=1, transport=00h/80h. Между запросом и ответом нужно обслужить WRITE_GRANT. WRITE_END не нужен. Неверный sequence даёт RANGE, выравнивание - LENGTH, нехватка места в кольце - NO_MEMORY. Успех возвращает следующий sequence и published в кадрах.',
'STREAM_EOF': 'Сообщает, что новых данных не будет. Остаток доигрывается даже при fill меньше prefill. После этого FEED даёт STATE. Дождитесь state=3 и вызовите CLOSE: EOF сам по себе не освобождает кольцо.',
'STREAM_CLOSE': 'Закрывает указанное кольцо и освобождает его после применения события звуковой частью. Состояние closing можно увидеть в STATE. Повтор во время закрытия даёт STATE, после удаления - HANDLE; заполненная очередь событий - BUSY.',
'SNAPSHOT': 'Фиксирует согласованную сводку и записи голосов/FX. Для страниц используйте возвращённые session и snapshot_seq. Новый SNAPSHOT или SNAP_LATCH заменяет удерживаемую копию. Сам запрос не останавливает звук.',
'FX_STATUS': 'Читает записи FX из удерживаемого снимка. first - индекс записи, max_records=1..6; большее значение ограничивается вместимостью ответа, ноль даёт BAD_ARGUMENT. Stereo занимает одну запись с channels=2. Неверный ключ снимка даёт STATE, first>total - RANGE; first=total возвращает count=0.',
'VOICE_STATUS': 'Читает все физические голоса, включая незанятые. first - индекс записи, max_records=1..5; большее значение ограничивается вместимостью ответа, ноль даёт BAD_ARGUMENT. Ключ берётся из SNAPSHOT. Неверный ключ даёт STATE, first>total - RANGE; first=total возвращает пустую страницу.',
}
def fields(fs):
    off=0;rows=[]
    for f in fs:
        n=size(f['type']); note=NOTES.get(f.get('note',''),f.get('note',''))
        if 'const' in f:note+='; значение '+str(f['const'])
        if f.get('verifiedOnly'):note+='; только VERIFIED'
        if f['type'].startswith('varray:'):note+='; count записей указанного типа'
        if f['name']=='playlist_entries':note='Фактически 0 (схема const32 устарела; очереди не реализованы)'
        display=f['type'].replace('struct:','')
        if display.startswith('varray:'):display=display[7:]+'[]'
        if display.startswith('bytes:'):display='byte['+display[6:]+']'
        rows.append([off,f['name'],display,n or 'по count',note.strip('; ') or '-'])
        off+=n
    return table(['Смещ.','Поле','Тип','Байт','Примечание'],rows) if rows else 'Нет полезных данных (0 байт).\n'
def wire():
    out=[]
    for op in sorted(s['opcodes'],key=lambda o:int(o['hex'],16)):
        reserved=op['name'].startswith('QUEUE_')
        out.append('#### '+op['hex'][2:]+'h '+op['name']+(' (резерв)' if reserved else '')+'\n')
        if reserved:out.append('Не реализована: BAD_OPCODE, полезных данных успешного ответа нет.\n');continue
        out.append(USAGE[op['name']]+'\n')
        for key,label in [('req','Запрос'),('resp','Ответ при OK')]:
            st=op.get(key+'Struct')
            description='.'
            if st:
                desc=s['structs'][st];n=desc['size']
                optional=sum(size(f['type']) for f in desc['fields'] if f.get('verifiedOnly'))
                amount=(f'{n} байт FAST; {n+optional} байт VERIFIED' if optional else f'{n} байт')
                description=': '+st+' ('+amount+').'
            out.append('**'+label+'**'+description+'\n')
            out.append(fields(s['structs'][st]['fields'] if st else op.get(key,[])))
        if op.get('transferOk'):out.append('Разрешена во время передачи блока'+('; только для объекта этой передачи' if op['name']=='OBJECT_INFO' else '')+'.\n')
    out.append('### 9.8. Вложенные структуры и записи\n')
    for name in ['PCM_DESC','PAGE_HEADER','VOICEREC','FXREC']:
        out.append('#### '+name+' ('+str(s['structs'][name]['size'])+' байт)\n')
        out.append(fields(s['structs'][name]['fields']))
    return '\n'.join(out)
def gs():
    spec=(ROOT/'ultra-gs-docs/ultra-gs.md').read_text()
    part=spec.split('### 8.2. Обязательные команды')[1].split('Все остальные opcode')[0]
    rows=[]
    for line in part.splitlines():
        if not re.match(r'\| [0-9A-F]{2}',line):continue
        cells=re.split(r'(?<!\\)\|',line)[1:-1]
        cells=[re.sub(r'\s*\[ROM[^]]*\]','',x.strip()) for x in cells]
        cells=[re.sub(r',?\s*§8\.\d+(?:\.\d+)?','',x) for x in cells]
        cells=[x.replace('\\|','|') for x in cells]
        opcode=int(cells[0][:2],16)
        item=next(o for o in s['gsCommands'] if int(o['hex'],16)==opcode)
        symbol=item['name']
        exchange=[]
        if item['pre']!=0:exchange.append('SD(pre)')
        exchange.extend(['SC '+cells[0][:2]+'h','WC'])
        if item['post']!=0:exchange.append('SD/WD × '+str(item['post'] if item['post']>0 else 1))
        if item.get('load'):exchange.extend(['SD/WD для каждого байта файла','SC D2h','WC','GD(handle)'])
        elif item['out']:exchange.append('GD'+('; WN/GD × '+str(item['out']-1) if item['out']>1 else ''))
        elif '[' in cells[2]:exchange.append('GD(out), необязательно')
        cells[3]=symbol+'. '+cells[3]+'. Пример обмена: '+', '.join(exchange)+'.'
        rows.append(cells)
    return table(['GS hex','pre; post','out','Назначение и влияние'],rows)
def ports():
    rows=[]
    for r in s['registers']:
        n=int(r['off'],16);end='..'+r['through'][2:] if 'through' in r else ''
        rows.append([f'{n:02X}'+end,f'{0x2a0+n:04X} / {0xc2a0+n:04X}',r['name'],r['read'],r['write']])
    rows.extend([['-','01D0..01D2 / C1D0..C1D2','CONFIG','selector/data','unlock/select/data'],['-','00B3 / C0B3','GSALIAS DATA','GS out','GS in'],['-','00BB / C0BB','GSALIAS CMD/STATUS','status','command'],['-','0388 / C388','OPL2','status','address'],['-','0389 / C389','OPL2 data','FFh','value']])
    out=table(['Смещ.','ISA / Z80','Регистр','Чтение','Запись'],rows)
    out+='\n'+table(['X_STATUS бит','Название'],[[v['bit'],k] for k,v in s['xStatus'].items()])
    return out
ACTIONS={
'NO_HANDLES':'Лимит объектов или выдач handles; освободить свои объекты, при исчерпании session требуется согласованный reset.',
'UNSUPPORTED_MEMORY':'Память платы не поддержана; проверить аппаратную конфигурацию.',
'CANCELLED':'Операция отменена; завершить очистку собственных ресурсов.',
'INTERNAL':'Сохранить диагностику; не продолжать изменение store.',
'OK':'Операция завершена; проверить длину ответа.',
'BAD_OPCODE':'Проверить API/CAPS; не использовать резерв QUEUE.',
'BAD_ARGUMENT':'Проверить флаги, reserved, gain и параметры.',
'LENGTH':'Исправить длину payload/число данных, сбросить FAULT при необходимости.',
'CRC':'Не использовать повреждённый ответ; сверить результат изменяющей команды.',
'BUSY':'Дождаться конца своей операции с deadline; не сбрасывать чужие ресурсы.',
'STATE':'Проверить состояние/ключ snapshot/READY, начать новый snapshot при stale key.',
'HANDLE':'Проверить session и принадлежность handle/ID.',
'RANGE':'Проверить offset, N, номер страницы, order/row.',
'NO_MEMORY':'Проверить free и largest; освободить свои объекты либо уменьшить запрос.',
'NO_VOICE':'Отложить звук; не останавливать чужую музыку.',
'FORMAT':'Проверить поддержанный формат и целостность файла.',
'PINNED':'Остановить свои instances и дождаться снятия pins.',
'TIMEOUT':'Закрыть окно, выполнить ограниченное восстановление и сверку состояния.',
'PSRAM':'Остановить сценарий; сохранить диагностику памяти.',
'UNDERFLOW':'Не читать FIFO без REPLY/READ_GRANT; восстановить framing.',
'OVERFLOW':'Не передавать лишние байты; проверить исчерпание token/sequence.',
'SHORT_TRANSFER':'Додать нельзя после отмены: начать корректный блок заново.',
'BAD_REGISTER':'Исправить адрес/направление доступа.',
}
def errors():return table(['Код hex','Ошибка','Действие'],[[e['value'][2:],e['name'],ACTIONS.get(e['name'],'Проверить состояние, сохранить код; не повторять изменяющую команду вслепую.')] for e in s['errors']])
p=argparse.ArgumentParser();p.add_argument('--check',action='store_true');a=p.parse_args()
text=DOC.read_text();new=text
for key,value in [('gs',gs()),('wire',wire()),('ports',ports()),('errors',errors())]:
    pattern=r'(<!-- generated:'+key+r' -->).*?(<!-- /generated:'+key+r' -->)'
    new=re.sub(pattern,lambda m:m[1]+'\n\n'+value.strip()+'\n\n'+m[2],new,flags=re.S)
for path in re.findall(r'<!-- source:(.*?) -->',new):
    code=(ROOT/path).read_text().rstrip()
    pattern=r'(<!-- source:'+re.escape(path)+r' -->).*?(<!-- /source -->)'
    new=re.sub(pattern,lambda m:m[1]+'\n\n```asm\n'+code+'\n```\n\n'+m[2],new,flags=re.S)
for path,start,end in re.findall(r'<!-- excerpt:(.*?)#(.*?)#(.*?) -->',new):
    source=(ROOT/path).read_text()
    code=source.split(start+':',1)[1].split(end+':',1)[0].rstrip()
    # Comments introducing the next procedure are outside this excerpt.
    lines=code.splitlines()
    while lines and (not lines[-1].strip() or lines[-1].lstrip().startswith(';')):lines.pop()
    code='\n'.join(lines)
    code=start+':'+code
    pattern=r'(<!-- excerpt:'+re.escape(path+'#'+start+'#'+end)+r' -->).*?(<!-- /excerpt -->)'
    new=re.sub(pattern,lambda m:m[1]+'\n\n```asm\n'+code+'\n```\n\n'+m[2],new,flags=re.S)
for path,tag in re.findall(r'<!-- snippet:(.*?)#(.*?) -->',new):
    source=(ROOT/path).read_text()
    start='; docs:'+tag+':begin\n';end='; docs:'+tag+':end'
    assert source.count(start)==source.count(end)==1,(path,tag)
    code=source.split(start,1)[1].split(end,1)[0].rstrip()
    pattern=r'(<!-- snippet:'+re.escape(path+'#'+tag)+r' -->).*?(<!-- /snippet -->)'
    new=re.sub(pattern,lambda m:m[1]+'\n\n```asm\n'+code+'\n```\n\n'+m[2],new,flags=re.S)
new=new.rstrip()+'\n'
if a.check:
    if new!=text:raise SystemExit('Stale tables/listings: run python3 tools/ultrags/docs-sync.py')
    for target in re.findall(r'\]\(([^)]+)\)',new):
        if '://' not in target and not target.startswith('#'):
            assert (DOC.parent/target.split('#')[0]).exists(),target
    print('Markdown tables, source listings and local links PASS')
else:DOC.write_text(new)
