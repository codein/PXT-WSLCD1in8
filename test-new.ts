LCD1IN8.LCD_Init()
LCD1IN8.LCD_SetBL(330)
LCD1IN8.LCD_Clear()
LCD1IN8.LCD_ClearBuf()

// Draw something
LCD1IN8.DrawPoint(50, 50, 0xF800, DOT_PIXEL.DOT_PIXEL_2)
LCD1IN8.DisString(10, 10, "Hello", COLOR.RED)
// Only update changed area
LCD1IN8.LCD_DisplayDirty()

input.onButtonPressed(Button.A, function () {
    LCD1IN8.DisString(
        56,
        68,
        "Hello",
        28011
    )
    LCD1IN8.LCD_DisplayDirty()
})

input.onButtonPressed(Button.B, function () {
    LCD1IN8.DisString(
        56,
        88,
        "World",
        28011
    )
    LCD1IN8.LCD_DisplayDirty()
})

basic.forever(function () {

})