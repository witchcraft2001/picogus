/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "sdk_mock.h"
#define GPIO_IN false
#define GPIO_OUT true
#define GPIO_FUNC_SIO 5
void gpio_set_dir(unsigned pin, bool out);
void gpio_put(unsigned pin, bool level);
