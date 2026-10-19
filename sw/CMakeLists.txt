# Generated Cmake Pico project file

cmake_minimum_required(VERSION 3.13)

set(PICO_BOARD_HEADER_DIRS ${CMAKE_CURRENT_LIST_DIR}/boards)
if(NOT PICO_BOARD)
    set(PICO_BOARD "picogus2")
    message("PICO_BOARD not set, defaulting to ${PICO_BOARD}")
endif()
set(PICO_COPY_TO_RAM 1)

# Initialise pico_sdk from installed location
# (note this can come from environment, CMake cache etc)
# to manually set Pico SDK path, uncomment this with your path.
# Otherwise, the environment variable PICO_SDK_PATH will be used.
#set(PICO_SDK_PATH "${CMAKE_CURRENT_LIST_DIR}/../../pico/pico-sdk")

# Pull in Raspberry Pi Pico SDK (must be before project)
include(pico_sdk_import.cmake)

project(picogus
    VERSION "4.1.1"
    LANGUAGES C CXX ASM
)

# Full version string including pre-release suffix (if any).
# CMake's project(VERSION) only allows numeric components, so the suffix lives here.
set(PICOGUS_VERSION "${CMAKE_PROJECT_VERSION}")

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)

include(pico_extras_import.cmake)

#set(PICO_DEOPTIMIZED_DEBUG "1")
#set(CMAKE_BUILD_TYPE "Debug")
set(CMAKE_BUILD_TYPE "Release")
#set(SKIP_PICO_MALLOC 1)

if(NOT PROJECT_TYPE)
    set(PROJECT_TYPE "GUS")
    message("PROJECT_TYPE not set, defaulting to ${PROJECT_TYPE}")
endif()

set(PICO_TINYUSB_PATH ${CMAKE_CURRENT_LIST_DIR}/tinyusb)

# Initialise the Raspberry Pi Pico SDK
pico_sdk_init()

################################################################################
# Helper function for setting linker script
function(set_linker_script TARGET script)
    target_link_directories(${TARGET} PRIVATE ${CMAKE_CURRENT_LIST_DIR}/multifw)
    pico_set_linker_script(${TARGET} ${script})

    # Add dependencies on the 'included' linker scripts so that the target gets
    # rebuilt if they are changed
    pico_add_link_depend(${TARGET} ${script})
endfunction()


option(PGDEBUG "Enable debug printf framework" OFF)
find_package(Python3 COMPONENTS Interpreter QUIET)

# Global definitions across all targets
add_compile_definitions(
    # 370MHz is extremely closely evenly divisible by 44100Hz.
    # Actual overclock happens at runtime via overclock_370mhz() since 370MHz
    # requires PLL REFDIV=2 which can't be set via SDK boot-time defaults.
    RP2_CLOCK_SPEED=370000
    PICO_DEFAULT_UART=0
    PICO_DEFAULT_UART_TX_PIN=28
    PICO_DEFAULT_UART_RX_PIN=-1
    PICO_DEFAULT_UART_BAUD_RATE=230400
    PICO_STDIO_USB_CONNECT_WAIT_TIMEOUT_MS=250
)

################################################################################
# Helper function for common firmware build
function(config_target TARGET_NAME MULTIFW)
    # Add executable. Default name is the project name, version 0.1
    add_executable(${TARGET_NAME} picogus.cpp)
    set_target_properties(${TARGET_NAME} PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR})
    pico_set_program_version(${TARGET_NAME} ${PICOGUS_VERSION})

    # Add include directory for the new structure
    target_include_directories(${TARGET_NAME} PRIVATE
        ${CMAKE_CURRENT_LIST_DIR}
    )

    target_compile_definitions(${TARGET_NAME} PRIVATE
        USE_AUDIO_I2S=1
        PICO_AUDIO_I2S_DATA_PIN=16
        PICO_AUDIO_I2S_CLOCK_PIN_BASE=17
        PICO_AUDIO_I2S_PIO=1
        PICO_AUDIO_I2S_SM=3
        M62429_PIO=1
    )

    if(USE_LTO)
        # Pico SDK must be patched to allow for LTO so it is not enabled by default.
        # To patch to Pico SDK, run:
        # sed -i 's/WRAPPER_FUNC(x) __wrap_/WRAPPER_FUNC(x) __attribute__((used)) __wrap_/' "$PICO_SDK_PATH"/src/rp2_common/pico_platform/include/pico/platform.h
        target_compile_options(${TARGET_NAME} PRIVATE -flto=jobserver)
    endif()

    target_sources(${TARGET_NAME} PRIVATE system/pico_reflash.c system/flash_settings.c multifw/ug_catalog.c ultrags/ug_config.c ultrags/ug_maintenance.cpp)
    # target_compile_options(${TARGET_NAME} PRIVATE -save-temps -fverbose-asm)
    if(MULTIFW)
        target_compile_definitions(${TARGET_NAME} PRIVATE UG_BUNDLE=1)
        set_linker_script(${TARGET_NAME} ${CMAKE_BINARY_DIR}/${TARGET_NAME}.ld)
    endif()

    if(USB_JOYSTICK OR USB_MOUSE OR CDROM)
        set(USB_STACK TRUE)
    endif()
    if (USB_STACK)
        # USB stack common stuff
        target_link_libraries(${TARGET_NAME} tinyusb_host)
        target_compile_definitions(${TARGET_NAME} PRIVATE USB_STACK=1)
        target_sources(${TARGET_NAME} PRIVATE usb_hid/hid_app.c)
    endif()
    if(USB_JOYSTICK)
        # Joystick stuff
        target_link_libraries(${TARGET_NAME} hardware_pwm)
        target_include_directories(${TARGET_NAME} PUBLIC ${CMAKE_CURRENT_LIST_DIR}/usb_hid)
        target_link_libraries(${TARGET_NAME} xinput_host)
        target_compile_definitions(${TARGET_NAME} PRIVATE USB_JOYSTICK=1)
    endif()
    if (USB_MOUSE) 
        # USB Mouse stuff
        target_include_directories(${TARGET_NAME} PUBLIC ${CMAKE_CURRENT_LIST_DIR}/mouse)
        target_compile_definitions(${TARGET_NAME} PRIVATE USB_MOUSE=1)
        target_sources(${TARGET_NAME} PRIVATE
            mouse/8250uart.cpp
            mouse/sermouse.cpp
        )
    endif()
    if(CDROM)
        target_link_libraries(${TARGET_NAME} cdrom)
        target_sources(${TARGET_NAME} PRIVATE
            mke/mke.c
            cdrom/msc_app.c
        )
        target_compile_definitions(${TARGET_NAME} PRIVATE CDROM=1)
        target_sources(${TARGET_NAME} PRIVATE
            ${CMAKE_CURRENT_LIST_DIR}/fatfs/source/ff.c
            ${CMAKE_CURRENT_LIST_DIR}/fatfs/source/ffsystem.c
            ${CMAKE_CURRENT_LIST_DIR}/fatfs/source/ffunicode.c
        )
        target_include_directories(${TARGET_NAME} PRIVATE
            ${CMAKE_CURRENT_LIST_DIR}/fatfs/source/
        )
    endif()

    target_sources(${TARGET_NAME} PRIVATE
        M62429/M62429.cpp
        system/pico_pic.c
    )
    pico_generate_pio_header(${TARGET_NAME} ${CMAKE_CURRENT_LIST_DIR}/M62429/M62429.pio)
    pico_generate_pio_header(${TARGET_NAME} ${CMAKE_CURRENT_LIST_DIR}/isa/isa_io.pio)

    if(SOUND_MPU)
        target_sources(${TARGET_NAME} PRIVATE mpu401/mpu401.c mpu401/midi.c)
        target_compile_definitions(${TARGET_NAME} PRIVATE SOUND_MPU=1)
    endif()


    if(SOUND_OPL)
        if(USE_YMF3812)
            # ymfm ym3812 (OPL2): 9 ch / 18 op / 1 output — ~3-4x faster than ymf262.
            # USE_YMF3812=1 is propagated automatically via opl_ym3812's INTERFACE definitions.
            target_compile_definitions(${TARGET_NAME} PRIVATE
                SOUND_OPL=1
                OPL_CMD_BUFFER=1
            )
            target_link_libraries(${TARGET_NAME} opl_ym3812)
        elseif(USE_YMFM_OPL)
            # ymfm ymf262 (OPL3): 18 ch / 36 op / 4 outputs — games detect OPL3.
            target_compile_definitions(${TARGET_NAME} PRIVATE
                SOUND_OPL=1
                USE_YMFM_OPL=1
                OPL_CMD_BUFFER=1
            )
            target_link_libraries(${TARGET_NAME} opl_ymfm)
        elseif(USE_DBOPL_OPL)
            # DOSBox OPL emulation
            target_compile_definitions(${TARGET_NAME} PRIVATE
                SOUND_OPL=1
                USE_DBOPL_OPL=1
                OPL_CMD_BUFFER=1
            )
            target_link_libraries(${TARGET_NAME} opl_dbopl)
        else()
            # Default: emu8950 (OPL2, assembly-optimized for RP2040)
            target_compile_definitions(${TARGET_NAME} PRIVATE
                SOUND_OPL=1
                USE_EMU8950_OPL=1
                EMU8950_ASM=1
                EMU8950_TLL_FLASH=1 # pre-computed TLL table stored in flash via .flashdata section (not copied to RAM)
                EMU8950_NO_FLOAT=1 # RP2040 has no FPU; float only used in TLL init anyway
                EMU8950_NO_TIMER=1 # disable timer which isn't used
                EMU8950_NO_TEST_FLAG=1 # disable test flags (which aren't used)
                OPL_CMD_BUFFER=1 # queue OPL writes on core 0, drain on core 1 to eliminate cross-core struct race
            )
            target_link_libraries(${TARGET_NAME} opl)
        endif()
    endif()

    target_link_libraries(
        ${TARGET_NAME}
        pico_stdlib
        pico_multicore
        pico_audio_i2s
        pico_flash
        hardware_pio
        hardware_pll
        hardware_flash
        hardware_adc
        hardware_exception
    )
    pico_add_extra_outputs(${TARGET_NAME})
    
    # Determine which stdio drivers are available for this firmware type
    if (SOUND_MPU)
        pico_enable_stdio_uart(${TARGET_NAME} 0)
    else()
        set(HAS_STDIO_UART TRUE)
    endif()
    if (USB_STACK)
        pico_enable_stdio_usb(${TARGET_NAME} 0)
    else()
        set(HAS_STDIO_USB TRUE)
    endif()

    if(PGDEBUG AND (HAS_STDIO_UART OR HAS_STDIO_USB))
        # Debug output is possible: enable available drivers and printf formatter
        target_compile_definitions(${TARGET_NAME} PRIVATE PGDEBUG=1)
        target_compile_definitions(rp2040-psram INTERFACE PSRAM_DEBUG=1)
        if (HAS_STDIO_UART)
            pico_enable_stdio_uart(${TARGET_NAME} 1)
        endif()
        if (HAS_STDIO_USB)
            pico_enable_stdio_usb(${TARGET_NAME} 1)
        endif()
    else()
        # No debug output possible or not requested: strip printf entirely
        if (NOT SOUND_MPU)
            pico_enable_stdio_uart(${TARGET_NAME} 0)
        endif()
        if (NOT USB_STACK)
            pico_enable_stdio_usb(${TARGET_NAME} 0)
        endif()
        pico_set_printf_implementation(${TARGET_NAME} none)
    endif()
    if(NOT PGDEBUG AND Python3_FOUND)
        # With printf stripped, __wrap_snprintf is the panic stub, so any
        # stray printf call dead-loops the firmware. Fail the build if we
        # find one.
        add_custom_command(TARGET ${TARGET_NAME} POST_BUILD
            COMMAND ${Python3_EXECUTABLE}
                ${CMAKE_CURRENT_LIST_DIR}/scripts/check_printf_leak.py
                ${CMAKE_OBJDUMP} ${CMAKE_ADDR2LINE}
                $<TARGET_FILE:${TARGET_NAME}>
            VERBATIM
        )
    endif()
    pico_enable_stdio_semihosting(${TARGET_NAME} 0)
    if(NOT CMAKE_CURRENT_BINARY_DIR STREQUAL CMAKE_BINARY_DIR)
        add_custom_command(TARGET ${TARGET_NAME} POST_BUILD COMMAND ${CMAKE_COMMAND} -E copy_if_different
            ${CMAKE_CURRENT_BINARY_DIR}/${TARGET_NAME}.uf2 ${CMAKE_BINARY_DIR}/${TARGET_NAME}.uf2)
    endif()
    set(UG_EVIDENCE ${CMAKE_CURRENT_LIST_DIR}/../tools/ultrags/s2-evidence.py)
    set_property(TARGET ${TARGET_NAME} APPEND PROPERTY LINK_DEPENDS ${UG_EVIDENCE} ${CMAKE_CURRENT_LIST_DIR}/CMakeLists.txt)
    add_custom_command(TARGET ${TARGET_NAME} POST_BUILD
        COMMAND ${Python3_EXECUTABLE} ${UG_EVIDENCE} --build ${CMAKE_BINARY_DIR}
            --elf $<TARGET_FILE:${TARGET_NAME}> --target ${TARGET_NAME} VERBATIM)
endfunction()

add_subdirectory(${CMAKE_CURRENT_LIST_DIR}/tusb_xinput)
add_subdirectory(rp2040-psram)
add_subdirectory(opl)
add_subdirectory(ne2000)
add_subdirectory(cdrom)
add_subdirectory(resampler)

################################################################################
# Build GUS firmware
function(build_gus TARGET_NAME MULTIFW)
    set(USB_JOYSTICK TRUE)
    set(SOUND_MPU TRUE)
    config_target(${TARGET_NAME} ${MULTIFW})
    pico_set_program_name(${TARGET_NAME} "picogus-gus")
    target_sources(${TARGET_NAME} PRIVATE
        audio/volctrl.cpp
        gusplay.cpp
        isa/isa_dma.c
        audio/audio_i2s_minimal.c
    )
    target_compile_definitions(${TARGET_NAME} PRIVATE
        SOUND_GUS=1
        PSRAM=1
        TEST_PSRAM=1
        PSRAM_ASYNC=1
        #PSRAM_ASYNC_DMA_IRQ=1
        PSRAM_SPINLOCK=1
        # PSRAM_MUTEX=1
        # PSRAM_WAITDMA=1
        PSRAM_CORE0=1
        PSRAM_PIN_CS=1
        PSRAM_PIN_SCK=2
        PSRAM_PIN_MOSI=3
        PSRAM_PIN_MISO=0
        # POLLING_DMA=1
        INTERP_CLAMP=1
        # INTERP_LINEAR=1
        SCALE_22K_TO_44K=1
        # FORCE_28CH_27CH=1
    )
    pico_generate_pio_header(${TARGET_NAME} ${CMAKE_CURRENT_LIST_DIR}/isa/isa_dma.pio)
    target_link_libraries(${TARGET_NAME} rp2040-psram hardware_interp)
endfunction()

option(SOUND_WSS "Build SB firmware with WSS (AD1848) support instead of SB16 DSP" OFF)
################################################################################
# Build SB firmware
function(build_sb_8950 TARGET_NAME MULTIFW)
    set(USB_JOYSTICK TRUE)
    set(SOUND_MPU TRUE)
    set(SOUND_OPL TRUE)
    set(CDROM TRUE)
    config_target(${TARGET_NAME} ${MULTIFW})
    pico_set_program_name(${TARGET_NAME} "picogus-sb")
    target_sources(${TARGET_NAME} PRIVATE
        audio/volctrl.cpp
        sbplay.cpp
        isa/isa_dma.c
        audio/audio_fifo.c
        audio/audio_i2s_minimal.c
    )
    if(SOUND_WSS)
        target_sources(${TARGET_NAME} PRIVATE ad1848/ad1848.cpp)
        target_compile_definitions(${TARGET_NAME} PRIVATE SOUND_WSS=1)
    else()
        target_sources(${TARGET_NAME} PRIVATE sbdsp/sbdsp.cpp)
    endif()
    target_compile_definitions(${TARGET_NAME} PRIVATE
        SOUND_SB=1
        SOUND_DSP=1
        USE_CD_AUDIO_FIFO=1
        # USE_IRQ=1
        # AUDIO_CALLBACK_CORE0=1
    )
    target_link_libraries(${TARGET_NAME} resampler)
    pico_generate_pio_header(${TARGET_NAME} ${CMAKE_CURRENT_LIST_DIR}/isa/isa_dma.pio)
endfunction()

################################################################################
# Build SB firmware — ymfm ymf262 OPL3
function(build_sb_ymf262 TARGET_NAME MULTIFW)
    set(USE_YMFM_OPL TRUE)
    set(USB_JOYSTICK TRUE)
    set(SOUND_MPU TRUE)
    set(SOUND_OPL TRUE)
    set(CDROM TRUE)
    config_target(${TARGET_NAME} ${MULTIFW})
    pico_set_program_name(${TARGET_NAME} "picogus-sb-ymf262")
    target_sources(${TARGET_NAME} PRIVATE
        audio/volctrl.cpp
        sbdsp/sbdsp.cpp
        sbplay.cpp
        isa/isa_dma.c
        audio/audio_fifo.c
        audio/audio_i2s_minimal.c
    )
    target_compile_definitions(${TARGET_NAME} PRIVATE
        SOUND_SB=1
        SOUND_DSP=1
        SB_BUFFERLESS=1
        SB_BUFFERLESS_NG=1
        USE_CD_AUDIO_FIFO=1
    )
    target_link_libraries(${TARGET_NAME} resampler)
    pico_generate_pio_header(${TARGET_NAME} ${CMAKE_CURRENT_LIST_DIR}/isa/isa_dma.pio)
endfunction()

################################################################################
# Build SB firmware — DOSBox OPL3 core
function(build_sb_dbopl3 TARGET_NAME MULTIFW)
    set(USE_DBOPL_OPL TRUE)
    set(USB_JOYSTICK TRUE)
    set(SOUND_MPU TRUE)
    set(SOUND_OPL TRUE)
    set(CDROM TRUE)
    config_target(${TARGET_NAME} ${MULTIFW})
    pico_set_program_name(${TARGET_NAME} "picogus-sb-dbopl3")
    target_sources(${TARGET_NAME} PRIVATE
        audio/volctrl.cpp
        sbdsp/sbdsp.cpp
        sbplay.cpp
        isa/isa_dma.c
        audio/audio_fifo.c
        audio/audio_i2s_minimal.c
    )
    target_compile_definitions(${TARGET_NAME} PRIVATE
        SOUND_SB=1
        SOUND_DSP=1
        SB_BUFFERLESS=1
        SB_BUFFERLESS_NG=1
        USE_CD_AUDIO_FIFO=1
        INTERP_VOLCTRL=1
        INTERP_SB_LINEAR=1
    )
    target_link_libraries(${TARGET_NAME} resampler)
    target_link_libraries(${TARGET_NAME} hardware_interp)
    pico_generate_pio_header(${TARGET_NAME} ${CMAKE_CURRENT_LIST_DIR}/isa/isa_dma.pio)
endfunction()

################################################################################
# Build AdLib firmware
function(build_adlib TARGET_NAME MULTIFW)
    set(USB_JOYSTICK TRUE)
    set(USB_MOUSE TRUE)
    set(SOUND_MPU TRUE)
    set(SOUND_OPL TRUE)
    config_target(${TARGET_NAME} ${MULTIFW})
    pico_set_program_name(${TARGET_NAME} "picogus-adlib")
    target_sources(${TARGET_NAME} PRIVATE
        audio/volctrl.cpp
        sbplay.cpp
        audio/audio_i2s_minimal.c
    )
    target_link_libraries(${TARGET_NAME} resampler)
endfunction()

################################################################################
# Build AdLib firmware — ymf262 OPL3 variant
function(build_adlib_ymf262 TARGET_NAME MULTIFW)
    set(USE_YMFM_OPL TRUE)
    set(USB_JOYSTICK TRUE)
    set(USB_MOUSE TRUE)
    set(SOUND_MPU TRUE)
    set(SOUND_OPL TRUE)
    config_target(${TARGET_NAME} ${MULTIFW})
    pico_set_program_name(${TARGET_NAME} "picogus-adlib-ymf262")
    target_sources(${TARGET_NAME} PRIVATE
        audio/volctrl.cpp
        sbplay.cpp
        audio/audio_i2s_minimal.c
    )
    target_link_libraries(${TARGET_NAME} resampler)
endfunction()

################################################################################
# Build AdLib firmware — DOSBox OPL3 core
function(build_adlib_dbopl3 TARGET_NAME MULTIFW)
    set(USE_DBOPL3_OPL TRUE)
    set(USB_JOYSTICK TRUE)
    set(USB_MOUSE TRUE)
    set(SOUND_MPU TRUE)
    set(SOUND_OPL TRUE)
    config_target(${TARGET_NAME} ${MULTIFW})
    pico_set_program_name(${TARGET_NAME} "picogus-adlib-dbopl3")
    target_sources(${TARGET_NAME} PRIVATE
        audio/volctrl.cpp
        sbplay.cpp
        audio/audio_i2s_minimal.c
    )
    target_link_libraries(${TARGET_NAME} resampler)
endfunction()

################################################################################
# Build AdLib firmware — ymfm OPL2 (ym3812) variant
function(build_adlib_ym3812 TARGET_NAME MULTIFW)
    set(USE_YMF3812 TRUE)
    set(USB_JOYSTICK TRUE)
    set(USB_MOUSE TRUE)
    set(SOUND_MPU TRUE)
    set(SOUND_OPL TRUE)
    config_target(${TARGET_NAME} ${MULTIFW})
    pico_set_program_name(${TARGET_NAME} "picogus-adlib-ym3812")
    target_sources(${TARGET_NAME} PRIVATE
        audio/volctrl.cpp
        sbplay.cpp
        audio/audio_i2s_minimal.c
    )
    target_link_libraries(${TARGET_NAME} resampler)
endfunction()

################################################################################
# Build SB firmware — ymfm OPL2 (ym3812) variant
function(build_sb_ym3812 TARGET_NAME MULTIFW)
    set(USE_YMF3812 TRUE)
    set(USB_JOYSTICK TRUE)
    set(SOUND_MPU TRUE)
    set(SOUND_OPL TRUE)
    set(CDROM TRUE)
    config_target(${TARGET_NAME} ${MULTIFW})
    pico_set_program_name(${TARGET_NAME} "picogus-sb-ym3812")
    target_sources(${TARGET_NAME} PRIVATE
        audio/volctrl.cpp
        sbdsp/sbdsp.cpp
        sbplay.cpp
        isa/isa_dma.c
        audio/audio_fifo.c
        audio/audio_i2s_minimal.c
    )
    target_compile_definitions(${TARGET_NAME} PRIVATE
        SOUND_SB=1
        SOUND_DSP=1
        SB_BUFFERLESS=1
        SB_BUFFERLESS_NG=1
        USE_CD_AUDIO_FIFO=1
    )
    target_link_libraries(${TARGET_NAME} resampler)
    pico_generate_pio_header(${TARGET_NAME} ${CMAKE_CURRENT_LIST_DIR}/isa/isa_dma.pio)
endfunction()

################################################################################
# Build MPU-only firmware
function(build_mpu TARGET_NAME MULTIFW)
    set(USB_JOYSTICK TRUE)
    set(SOUND_MPU TRUE)
    config_target(${TARGET_NAME} ${MULTIFW})
    pico_set_program_name(${TARGET_NAME} "picogus-mpu401")
    target_compile_definitions(${TARGET_NAME} PRIVATE
        # Enable MPU-401 IRQ support only in this firmware
        MPU_IRQ=1
        # Larger buffer for sysex delay
        MPU_ONLY=1
    )
    target_sources(${TARGET_NAME} PRIVATE mpuplay.cpp)
endfunction()

################################################################################
# Build PSG firmware
function(build_psg TARGET_NAME MULTIFW)
    set(USB_JOYSTICK TRUE)
    set(USB_MOUSE TRUE)
    set(SOUND_MPU TRUE)
    config_target(${TARGET_NAME} ${MULTIFW})
    pico_set_program_name(${TARGET_NAME} "picogus-psg")
    target_compile_definitions(${TARGET_NAME} PRIVATE
        SOUND_TANDY=1
        SOUND_CMS=1
    )
    target_sources(${TARGET_NAME} PRIVATE
        audio/volctrl.cpp
        audio/audio_i2s_minimal.c
        square/square.cpp
    )
    target_sources(${TARGET_NAME} PRIVATE psgplay.cpp)
endfunction()

################################################################################
# Build USB-only firmware (joystick + mouse support)
function(build_usb TARGET_NAME MULTIFW)
    set(USB_JOYSTICK TRUE)
    set(USB_MOUSE TRUE)
    set(SOUND_MPU TRUE)
    set(CDROM TRUE)
    config_target(${TARGET_NAME} ${MULTIFW})
    pico_set_program_name(${TARGET_NAME} "picogus-usb")
    target_compile_definitions(${TARGET_NAME} PRIVATE
        USB_ONLY=1
        USE_CD_AUDIO_FIFO=1
    )
    target_sources(${TARGET_NAME} PRIVATE
        audio/volctrl.cpp
        audio/audio_fifo.c
        audio/audio_i2s_minimal.c
        usbplay.cpp
    )
endfunction()


function(build_ne2k TARGET_NAME MULTIFW)
    config_target(${TARGET_NAME} ${MULTIFW})
    pico_set_program_name(${TARGET_NAME} "picogus-ne2k")
    target_compile_definitions(${TARGET_NAME} PRIVATE
       NE2000=1
       PICOW=1
       CYW43_CONFIG_FILE="cyw43_firmware.h"
       CYW43_PIO_CLOCK_DIV_INT=3
    )
    target_sources(${TARGET_NAME} PRIVATE
        ne2000play.cpp
    )
    target_link_libraries(
        ${TARGET_NAME}
        ne2000        
    )
endfunction()


################################################################################
execute_process(COMMAND git rev-parse --short=16 HEAD WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR} OUTPUT_VARIABLE UG_REV OUTPUT_STRIP_TRAILING_WHITESPACE)
execute_process(COMMAND git diff --quiet WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR} RESULT_VARIABLE UG_DIRTY)
if(UG_DIRTY)
    string(SUBSTRING "${UG_REV}" 0 15 UG_REV)
    string(APPEND UG_REV "+")
endif()
set(UG_PSRAM_SCK_MHZ 100 CACHE STRING "Ultra GS PSRAM profile: 100 or 50 MHz nominal SCK")
if(NOT UG_PSRAM_SCK_MHZ MATCHES "^(50|100)$")
    message(FATAL_ERROR "UG_PSRAM_SCK_MHZ must be 50 or 100")
endif()
set(UG_ISA_WRITE_PROFILE "HANDSHAKE" CACHE STRING "Ultra GS IOW: HANDSHAKE or experimental POSTED")
set_property(CACHE UG_ISA_WRITE_PROFILE PROPERTY STRINGS HANDSHAKE POSTED)
if(NOT UG_ISA_WRITE_PROFILE MATCHES "^(HANDSHAKE|POSTED)$")
    message(FATAL_ERROR "UG_ISA_WRITE_PROFILE must be HANDSHAKE or POSTED")
endif()
function(ug_posted_target TARGET_NAME)
    if(UG_ISA_WRITE_PROFILE STREQUAL "POSTED")
        target_compile_definitions(${TARGET_NAME} PRIVATE UG_ISA_POSTED=1)
        target_sources(${TARGET_NAME} PRIVATE ultrags/ug_posted.c)
        pico_generate_pio_header(${TARGET_NAME} ${CMAKE_CURRENT_LIST_DIR}/ultrags/ug_posted_iow.pio)
    endif()
endfunction()
function(build_ultrags TARGET_NAME MULTIFW)
    find_program(UG_NODE node REQUIRED)
    set(UG_WIRE_DIR ${CMAKE_CURRENT_BINARY_DIR}/ug-wire)
    add_custom_command(OUTPUT ${UG_WIRE_DIR}/ug_wire.h
        COMMAND ${UG_NODE} ${CMAKE_CURRENT_LIST_DIR}/../tools/ultrags/gen-wire.mjs
            ${CMAKE_CURRENT_LIST_DIR}/../tools/ultrags/wire-schema.json ${UG_WIRE_DIR}
        DEPENDS ${CMAKE_CURRENT_LIST_DIR}/../tools/ultrags/gen-wire.mjs
            ${CMAKE_CURRENT_LIST_DIR}/../tools/ultrags/wire-schema.json)

    config_target(${TARGET_NAME} ${MULTIFW})
    ug_posted_target(${TARGET_NAME})
    if(UG_ISA_WRITE_PROFILE STREQUAL "HANDSHAKE")
        target_compile_definitions(${TARGET_NAME} PRIVATE UG_ISA_EARLY_READ=1)
        target_sources(${TARGET_NAME} PRIVATE ultrags/ug_handshake.c)
        pico_generate_pio_header(${TARGET_NAME} ${CMAKE_CURRENT_LIST_DIR}/ultrags/ug_handshake_ior.pio)
    endif()
    pico_set_program_name(${TARGET_NAME} "pg-ultrags")
    target_compile_definitions(${TARGET_NAME} PRIVATE SOUND_ULTRAGS=1 UG_BUILD_ID="${UG_REV}" PSRAM_ASYNC=1
        PSRAM_PIN_CS=1 PSRAM_PIN_SCK=2 PSRAM_PIN_MOSI=3 PSRAM_PIN_MISO=0)
    target_include_directories(${TARGET_NAME} PRIVATE ${UG_WIRE_DIR} ${CMAKE_CURRENT_LIST_DIR}/../common)
    target_sources(${TARGET_NAME} PRIVATE ${UG_WIRE_DIR}/ug_wire.h ultrags/ug_minimal.c ultrags/ug_play.cpp
        ultrags/ug_hwmap.c ultrags/ug_audio.c ultrags/ug_psram.c
        ultrags/ug_store.c ultrags/ug_memory.c ultrags/ug_storage.c ultrags/ug_pcm.c ultrags/ug_render.c ultrags/ug_mod.c)
    target_compile_definitions(${TARGET_NAME} PRIVATE UG_PSRAM_SCK_MHZ=${UG_PSRAM_SCK_MHZ})
    target_compile_options(${TARGET_NAME} PRIVATE -include ${CMAKE_CURRENT_LIST_DIR}/ultrags/ug_psram_wait.h)
    target_link_libraries(${TARGET_NAME} rp2040-psram hardware_dma pico_rand)
    pico_generate_pio_header(${TARGET_NAME} ${CMAKE_CURRENT_LIST_DIR}/ultrags/ug_psram_id.pio)
    pico_generate_pio_header(${TARGET_NAME} ${PICO_EXTRAS_PATH}/src/rp2_common/pico_audio_i2s/audio_i2s.pio)
endfunction()

# Build "multifw" - all firmwares in one UF2
if(PROJECT_TYPE STREQUAL "MULTIFW")
    set(FW_TARGET picogus)

    # ---------------------------------------------------------------------------
    # OPL variant for the adlib slot in the multifw bundle.
    # Uncomment exactly one of the lines below:
    set(MULTIFW_OPL_VARIANT "emu8950")   # original emu8950 — OPL2, assembly-optimized
    # set(MULTIFW_OPL_VARIANT "ym3812") # ymfm ym3812   — OPL2, ymfm quality
    # set(MULTIFW_OPL_VARIANT "ymf262") # ymfm ymf262   — OPL3, true stereo - note not yet fast enough for RP2040
    # ---------------------------------------------------------------------------
    if(MULTIFW_OPL_VARIANT STREQUAL "ymf262")
        set(ADLIB_TARGET_NAME "pg-adlib-ymf262")
        set(ADLIB_BUILD_FN build_adlib_ymf262)
    elseif(MULTIFW_OPL_VARIANT STREQUAL "ym3812")
        set(ADLIB_TARGET_NAME "pg-adlib-ym3812")
        set(ADLIB_BUILD_FN build_adlib_ym3812)
    else()
        set(ADLIB_TARGET_NAME "pg-adlib")
        set(ADLIB_BUILD_FN build_adlib)
    endif()
    message("Multifw OPL variant: ${MULTIFW_OPL_VARIANT} → ${ADLIB_TARGET_NAME}")

    set(UG_NAMES pg-gus ${ADLIB_TARGET_NAME} pg-mpu pg-psg pg-sb pg-usb pg-ultrags)
    set(UG_LINKERS)
    set(UG_FINAL)
    foreach(name IN LISTS UG_NAMES)
        list(APPEND UG_LINKERS ${CMAKE_BINARY_DIR}/${name}-multifw.ld)
        list(APPEND UG_FINAL ${name}-multifw)
    endforeach()
    set(UG_PACKER ${CMAKE_CURRENT_LIST_DIR}/../tools/ultrags/multifw.py)
    set(UG_PACK_ARGS --build ${CMAKE_BINARY_DIR} --sw ${CMAKE_CURRENT_LIST_DIR} --names ${UG_NAMES})
    add_custom_command(OUTPUT ${UG_LINKERS} ${CMAKE_BINARY_DIR}/generated/multifw/layout.json
        COMMAND ${Python3_EXECUTABLE} ${UG_PACKER} layout ${UG_PACK_ARGS}
        DEPENDS ${UG_NAMES} ${UG_PACKER} multifw/fw_memmap_c2ram.ld VERBATIM)
    add_custom_target(generate_flash_firmware_h DEPENDS ${UG_LINKERS})

    build_gus(pg-gus FALSE)
    build_gus(pg-gus-multifw TRUE)
    add_dependencies(pg-gus-multifw pg-gus generate_flash_firmware_h)
    cmake_language(CALL ${ADLIB_BUILD_FN} ${ADLIB_TARGET_NAME} FALSE)
    cmake_language(CALL ${ADLIB_BUILD_FN} ${ADLIB_TARGET_NAME}-multifw TRUE)
    add_dependencies(${ADLIB_TARGET_NAME}-multifw ${ADLIB_TARGET_NAME} generate_flash_firmware_h)
    build_mpu(pg-mpu FALSE)
    build_mpu(pg-mpu-multifw TRUE)
    add_dependencies(pg-mpu-multifw pg-mpu generate_flash_firmware_h)
    build_psg(pg-psg FALSE)
    build_psg(pg-psg-multifw TRUE)
    add_dependencies(pg-psg-multifw pg-psg generate_flash_firmware_h)
    build_sb_dbopl3(pg-sb FALSE)
    build_sb_dbopl3(pg-sb-multifw TRUE)
    add_dependencies(pg-sb-multifw pg-sb generate_flash_firmware_h)
    build_usb(pg-usb FALSE)
    build_usb(pg-usb-multifw TRUE)
    add_dependencies(pg-usb-multifw pg-usb generate_flash_firmware_h)

    build_ultrags(pg-ultrags FALSE)
    build_ultrags(pg-ultrags-multifw TRUE)
    add_dependencies(pg-ultrags-multifw generate_flash_firmware_h)
    add_custom_command(OUTPUT ${CMAKE_BINARY_DIR}/generated/multifw/recovery.h
            ${CMAKE_BINARY_DIR}/generated/multifw/catalog.bin
        COMMAND ${Python3_EXECUTABLE} ${UG_PACKER} catalog ${UG_PACK_ARGS}
        DEPENDS ${UG_FINAL} ${UG_PACKER} VERBATIM)
    add_custom_target(ug_manifest DEPENDS ${CMAKE_BINARY_DIR}/generated/multifw/recovery.h)
    add_executable(bootloader multifw/bootloader.c multifw/ug_catalog.c)
    set_target_properties(bootloader PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR})
    target_link_libraries(bootloader PRIVATE pico_stdlib hardware_watchdog hardware_exception)
    pico_add_extra_outputs(bootloader)
    target_include_directories(bootloader PRIVATE ${CMAKE_CURRENT_LIST_DIR} ${CMAKE_BINARY_DIR}/generated/multifw)
    pico_enable_stdio_uart(bootloader 0)
    pico_enable_stdio_usb(bootloader 0)
    pico_enable_stdio_semihosting(bootloader 0)
    if(NOT PGDEBUG)
        pico_set_printf_implementation(bootloader none)
    endif()
    if(NOT PGDEBUG AND Python3_FOUND)
        add_custom_command(TARGET bootloader POST_BUILD
            COMMAND ${Python3_EXECUTABLE}
                ${CMAKE_CURRENT_LIST_DIR}/scripts/check_printf_leak.py
                ${CMAKE_OBJDUMP} ${CMAKE_ADDR2LINE}
                $<TARGET_FILE:bootloader>
            VERBATIM
        )
    endif()
    if(NOT CMAKE_CURRENT_BINARY_DIR STREQUAL CMAKE_BINARY_DIR)
        add_custom_command(TARGET bootloader POST_BUILD COMMAND ${CMAKE_COMMAND} -E copy_if_different
            ${CMAKE_CURRENT_BINARY_DIR}/bootloader.uf2 ${CMAKE_BINARY_DIR}/bootloader.uf2)
    endif()
    set(UG_EVIDENCE ${CMAKE_CURRENT_LIST_DIR}/../tools/ultrags/s2-evidence.py)
    set_property(TARGET bootloader APPEND PROPERTY LINK_DEPENDS ${UG_EVIDENCE} ${CMAKE_CURRENT_LIST_DIR}/CMakeLists.txt)
    add_custom_command(TARGET bootloader POST_BUILD
        COMMAND ${Python3_EXECUTABLE} ${UG_EVIDENCE} --build ${CMAKE_BINARY_DIR}
            --elf $<TARGET_FILE:bootloader> --target bootloader VERBATIM)
    add_dependencies(bootloader ug_manifest)
    add_custom_command(OUTPUT ${CMAKE_BINARY_DIR}/picogus.uf2
        COMMAND ${Python3_EXECUTABLE} ${UG_PACKER} pack ${UG_PACK_ARGS}
        DEPENDS bootloader ug_manifest ${UG_FINAL} ${UG_PACKER} VERBATIM)
    add_custom_target(picogus ALL DEPENDS ${CMAKE_BINARY_DIR}/picogus.uf2)

################################################################################
# Builds for individual "legacy" firmware modes
elseif(PROJECT_TYPE STREQUAL "ULTRAGS")
    set(FW_TARGET pg-ultrags)
    build_ultrags(pg-ultrags FALSE)
elseif(PROJECT_TYPE STREQUAL "GUS")
    set(FW_TARGET pg-gus)
    build_gus(pg-gus FALSE)
elseif(PROJECT_TYPE STREQUAL "SB_EMU8950")
    set(FW_TARGET pg-sb-emu8950)
    build_sb_emu8950(pg-sb-emu8950 FALSE)
elseif(PROJECT_TYPE STREQUAL "SB_YMF262")
    set(FW_TARGET pg-sb-ymf262)
    build_sb_ymf262(pg-sb-ymf262 FALSE)
elseif(PROJECT_TYPE STREQUAL "SB_YM3812")
    set(FW_TARGET pg-sb-ym3812)
    build_sb_ym3812(pg-sb-ym3812 FALSE)
elseif(PROJECT_TYPE STREQUAL "SB_DBOPL3")
    set(FW_TARGET pg-sb-dbopl3)
    build_sb_dbopl3(pg-sb-dbopl3 FALSE)
elseif(PROJECT_TYPE STREQUAL "ADLIB")
    set(FW_TARGET pg-adlib)
    build_adlib(pg-adlib FALSE)
elseif(PROJECT_TYPE STREQUAL "ADLIB_YMFM")
    set(FW_TARGET pg-adlib-ymf262)
    build_adlib_ymf262(pg-adlib-ymf262 FALSE)
elseif(PROJECT_TYPE STREQUAL "ADLIB_YMF262")
    set(FW_TARGET pg-adlib-ymf262)
    build_adlib_ymf262(pg-adlib-ymf262 FALSE)
elseif(PROJECT_TYPE STREQUAL "ADLIB_YM3812")
    set(FW_TARGET pg-adlib-ym3812)
    build_adlib_ym3812(pg-adlib-ym3812 FALSE)
elseif(PROJECT_TYPE STREQUAL "ADLIB_DBOPL3")
    set(FW_TARGET pg-adlib-dbopl3)
    build_adlib_dbopl3(pg-adlib-dbopl3 FALSE)
elseif(PROJECT_TYPE STREQUAL "MPU")
    set(FW_TARGET pg-mpu)
    build_mpu(pg-mpu FALSE)
elseif(PROJECT_TYPE STREQUAL "PSG")
    set(FW_TARGET pg-psg)
    build_psg(pg-psg FALSE)
elseif(PROJECT_TYPE STREQUAL "USB")
    set(FW_TARGET pg-usb)
    build_usb(pg-usb FALSE)
elseif(PROJECT_TYPE STREQUAL "NE2K")
    set(FW_TARGET pg-ne2k)
    build_ne2k(pg-ne2k FALSE)
elseif(PROJECT_TYPE STREQUAL "ANALYZER")
    set(FW_TARGET pg-analyzer)
    add_executable(pg-analyzer isa_analyzer.cpp)
    pico_set_program_name(pg-analyzer "picogus-analyzer")
    pico_set_program_version(pg-analyzer ${PICOGUS_VERSION})

    target_compile_definitions(pg-analyzer PRIVATE
        PICO_MALLOC_PANIC=0
    )

    pico_generate_pio_header(pg-analyzer ${CMAKE_CURRENT_LIST_DIR}/isa_analyzer.pio)

    target_link_libraries(pg-analyzer
        pico_stdlib
        hardware_pio
    )

    pico_enable_stdio_uart(pg-analyzer 1)
    pico_enable_stdio_usb(pg-analyzer 0)
    pico_enable_stdio_semihosting(pg-analyzer 0)
    pico_add_extra_outputs(pg-analyzer)
endif()

################################################################################
# Ultra GS S0a standalone diagnostic (not a multifw slot image)
if(PROJECT_TYPE STREQUAL "ULTRAGS_DIAG")
    if(NOT Python3_FOUND)
        message(FATAL_ERROR "Ultra GS diagnostic requires Python3 for printf-leak verification")
    endif()
    set(FW_TARGET pg-ultrags-diag)
    add_executable(${FW_TARGET}
        ultrags/diag_main.cpp
        ultrags/ug_diag_guard.c
        ultrags/ug_diag_isa.c
        ultrags/ug_diag_link.c
        ultrags/ug_hwmap.c
        ultrags/ug_psram.c
        ultrags/ug_render.c
        ultrags/ug_profile.c
        ultrags/ug_audio.c
        ultrags/ug_spike.c
        M62429/M62429.cpp
    )
    ug_posted_target(${FW_TARGET})
    target_compile_options(${FW_TARGET} PRIVATE -include ${CMAKE_CURRENT_LIST_DIR}/ultrags/ug_psram_wait.h)
    option(UG_DIAG_NO_DACK "Standalone diagnostic without DACK gate" OFF)
    set(UG_DIAG_GEN ${CMAKE_CURRENT_BINARY_DIR}/diag-gen)
    add_custom_command(OUTPUT ${UG_DIAG_GEN}/ug_diag_wire.h
        COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_LIST_DIR}/../tools/ultrags/gen-diag.py
            ${CMAKE_CURRENT_LIST_DIR}/../tools/ultrags/diag-schema.json ${UG_DIAG_GEN}
        DEPENDS ${CMAKE_CURRENT_LIST_DIR}/../tools/ultrags/gen-diag.py
            ${CMAKE_CURRENT_LIST_DIR}/../tools/ultrags/diag-schema.json)
    target_sources(${FW_TARGET} PRIVATE ${UG_DIAG_GEN}/ug_diag_wire.h)
    target_include_directories(${FW_TARGET} PRIVATE ${UG_DIAG_GEN})
    if(UG_DIAG_NO_DACK)
        target_compile_definitions(${FW_TARGET} PRIVATE UG_DIAG_NO_DACK=1)
    endif()
    pico_generate_pio_header(${FW_TARGET} ${CMAKE_CURRENT_LIST_DIR}/ultrags/diag_iow.pio)
    pico_set_program_name(${FW_TARGET} "picogus-ultrags-diag")
    pico_set_program_version(${FW_TARGET} ${PICOGUS_VERSION})
    # standalone image: executes from SRAM (PICO_COPY_TO_RAM is global),
    # flash origin is the SDK default 0x10000000 -- NOT a slot-linked
    # multifw image; must not be packed into picogus.uf2
    target_include_directories(${FW_TARGET} PRIVATE
        ${CMAKE_CURRENT_LIST_DIR}
        ${CMAKE_CURRENT_LIST_DIR}/../common
    )
    target_compile_definitions(${FW_TARGET} PRIVATE
        ULTRAGS_DIAG=1
        PICO_AUDIO_I2S_DATA_PIN=16
        PICO_AUDIO_I2S_CLOCK_PIN_BASE=17
        PICO_AUDIO_I2S_PIO=1
        PICO_AUDIO_I2S_SM=3
        M62429_PIO=1
        PSRAM=1
        PSRAM_ASYNC=1
        PSRAM_PIN_CS=1
        PSRAM_PIN_SCK=2
        PSRAM_PIN_MOSI=3
        PSRAM_PIN_MISO=0
    )
    pico_generate_pio_header(${FW_TARGET} ${CMAKE_CURRENT_LIST_DIR}/isa/isa_io.pio)
    pico_generate_pio_header(${FW_TARGET} ${CMAKE_CURRENT_LIST_DIR}/M62429/M62429.pio)
    pico_generate_pio_header(${FW_TARGET}
        ${PICO_EXTRAS_PATH}/src/rp2_common/pico_audio_i2s/audio_i2s.pio)
    target_link_libraries(${FW_TARGET}
        pico_stdlib
        pico_multicore
        pico_rand
        rp2040-psram
        hardware_pio
        hardware_dma
        hardware_pll
        hardware_adc
        hardware_exception
        hardware_watchdog
        hardware_clocks
    )
    pico_add_extra_outputs(${FW_TARGET})
    if(PGDEBUG)
        target_compile_definitions(${FW_TARGET} PRIVATE PGDEBUG=1)
        pico_enable_stdio_uart(${FW_TARGET} 1)
        pico_enable_stdio_usb(${FW_TARGET} 1)
    else()
        pico_enable_stdio_uart(${FW_TARGET} 0)
        pico_enable_stdio_usb(${FW_TARGET} 0)
        pico_set_printf_implementation(${FW_TARGET} none)
    endif()
    if(NOT PGDEBUG AND Python3_FOUND)
        # printf is stripped in release; a leaked printf-family call would
        # dead-loop the firmware -- fail the build instead
        add_custom_command(TARGET ${FW_TARGET} POST_BUILD
            COMMAND ${Python3_EXECUTABLE}
                ${CMAKE_CURRENT_LIST_DIR}/scripts/check_printf_leak.py
                ${CMAKE_OBJDUMP} ${CMAKE_ADDR2LINE}
                $<TARGET_FILE:${FW_TARGET}>
            VERBATIM
        )
    endif()
    # Capture the actual compile dependencies at link time. Packaging cannot
    # manufacture a fresh manifest for a stale ELF after source changes.
    set(UG_DIAG_EVIDENCE ${CMAKE_CURRENT_LIST_DIR}/../tools/ultrags/firmware_evidence.py)
    set_property(TARGET ${FW_TARGET} APPEND PROPERTY LINK_DEPENDS
        ${UG_DIAG_EVIDENCE} ${CMAKE_CURRENT_LIST_FILE})
    add_custom_command(TARGET ${FW_TARGET} POST_BUILD
        COMMAND ${Python3_EXECUTABLE} ${UG_DIAG_EVIDENCE}
            --build ${CMAKE_CURRENT_BINARY_DIR} --elf $<TARGET_FILE:${FW_TARGET}>
        VERBATIM)
    pico_enable_stdio_semihosting(${FW_TARGET} 0)
endif()

################################################################################
# Optional target to program built firmware via openocd
add_custom_target(
    program
    DEPENDS ${FW_TARGET}
    COMMAND openocd -f interface/cmsis-dap.cfg -f target/rp2040.cfg -c "adapter speed 5000\; program ${FW_TARGET}.bin verify reset exit 0x10000000"
)
