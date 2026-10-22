    IFDEF APP_PLAY
    DB "UGPLAY file.MOD|file.WAV|file.RAW | HANDLE handle [/WAIT /LOOP /REPLACE]",13,10
    DB "MOD /GS: historical repeat, inherited 6A; /SLOW /VERIFY /REPLACE /WAIT",13,10
    DB "MOD only: /F00:IGNORE (default) | /F00:PAUSE; requires new firmware",13,10
    DB "RAW: /RATE:N /BITS:8|16 /CH:1|2 /FMT:U8|S8|S16LE",13,10
    DB "STREAM file.WAV|file.RAW /BUFFER:512 /PREFILL:256 /LOW:128 (KiB)",13,10
    DB "STREAM /BENCH:DISK|FEED|PIPE|ALL (FAST only); PCM 8000..48000 Hz, 8/16 mono/stereo",13,10
    DB "STREAM RAW default: 44100 S16LE stereo; ESC closes stream",13,10
    DB "STOP|PAUSE|RESUME | FX file | FXHANDLE handle",13,10
    DB "/VOICE:N /PRIORITY:N /GAIN:0..64 /PAN:0..255 /STEAL",13,10
    DB "FXSTOP id|ALL | FXPAUSE id | FXRESUME id",13,10
    ELSE
    DB "UGMON [/GS] /COUNT:N /HZ:1..10 (default 5); ESC exits monitor",13,10
    ENDIF
    DB "/SLOT:0|1 /BASE:hex /QUIET /?",13,10,0
