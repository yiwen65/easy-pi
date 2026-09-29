# Image reference 原生契约实测

日期：2026-09-29。当前安装未修改；这是诊断证据，不是局部校验候选的通过报告。

## 实验结果

在现有隔离 native 工作副本中新增独立集成测试，运行真实的 cua-driver-core ImageReference 和 PNG 编码器，没有 mock 比较函数。3/3 通过，编译及运行命令耗时约 12.81 秒，测试自身低于输出计时精度。

- 64×64 全白图，点击地址 (2,2)；只将 (63,63) 的红色通道改为零。包含目标的整个上半图完全相同，当前 matches 仍返回 false。证明远处单像素变化足以触发整图拒绝，不涉及模型推理或 GUI 输入。
- 保持图像/窗口/几何相同，只改变新捕获 image_id，matches 返回 true；旧引用的 addresses 仍拒绝新 ID。这区分了图像刷新比较与引用寻址，不能当作原生目标替换负例通过。
- 修改 PID、窗口 ID、窗口位置分别拒绝；越界坐标拒绝。

没有运行 PNG 不同编码但相同像素实验；源码散列对象是 PNG 字节，不把该静态事实算作本轮实测结果。

## 首个缺失信息点

核对工作副本源码：

- crates/cua-driver-core/src/controlled/image_reference.rs：只保存 image ID、PID、window ID、geometry、PNG digest，无 AX 控件身份。
- crates/cua-driver-sdk/src/computer/image.rs：start_capture 明确 include_accessibility_tree=false。
- crates/platform-macos/src/tools/computer.rs：capture 先 reset_snapshot，图像返回 elements=[]；image_action 也 reset_snapshot，派发前树扫描仅用于现态完整性/模态边界，并未与截图时控件比较。
- crates/platform-macos/src/input/controlled.rs：pointer 在移动前和移动后各做一次整图比较。鼠标移动是已提交输入，第二次拒绝不能表述为完全零派发。
- crates/platform-macos/src/tools/computer/observation.rs：现有 Scan 保留原生元素句柄和 parent/depth，但 Data 不含 geometry。树完整性明确不等于原子截图或隐藏 DOM 的完整性。

所以“将 matches 改成局部散列”不足以履行已授权候选的同外观替换门槛。最小后续实验应在现有捕获生命周期内验证控件身份与几何证据的获取/保留，再在动作点做命中比对；不要新增第二套长期缓存，也不要把一次派发前 hit-test 冒充跨观察身份验证。是否能复用既有 snapshot 生命周期仍需实现验证，不能先承诺。

负例判据细化：派发前已改变的目标应零输入；若目标在 tracking move 后改变，必须禁止 down/wheel，并如实报告已派发的 tracking move。该细化保留现有输入承诺语义，不授权隐藏已发生的输入。

## 复现

工作副本：/tmp/epi-pointer-boundary.PFHOUz/cua-driver/rust。测试文件放入 crates/cua-driver-core/tests/image_freshness_characterization.rs。临时目录可能清理，以下保留完整测试源码。

```sh
bash /Users/w/Projects/easy-pi/pi/.artifacts/computer/p03-offline-repair/env.sh cargo test --locked --offline -p cua-driver-core --test image_freshness_characterization
```

```rust
//! Characterization only: these passing tests expose current image-reference limits.
use cua_driver_contract::computer_image::{ComputerImage, ComputerImageGeometry};
use cua_driver_core::{controlled::ImageReference, image_utils::encode_rgba_to_png};

fn frame(pixels: &[u8]) -> ComputerImage {
    ComputerImage {
        image_id: "image-before".into(),
        pid: 7,
        window_id: 9,
        geometry: ComputerImageGeometry {
            desktop_x: 0.0, desktop_y: 0.0,
            window_width: 64.0, window_height: 64.0,
            source_width: 64, source_height: 64,
            crop_x: 0, crop_y: 0, crop_width: 64, crop_height: 64,
            output_width: 64, output_height: 64,
        },
        png: encode_rgba_to_png(pixels, 64, 64).unwrap(),
    }
}

#[test]
fn image_freshness_characterization_distant_pixel_invalidates_click_reference() {
    let pixels = vec![255; 64 * 64 * 4];
    let before = frame(&pixels);
    let reference = ImageReference::from_image(&before).unwrap();
    assert!(reference.addresses("image-before", 2, 2).is_ok());
    assert!(reference.matches(&before));
    let mut changed = pixels.clone();
    changed[(63 * 64 + 63) * 4] = 0;
    // The entire top half (including the requested click neighborhood) is identical.
    assert_eq!(&pixels[..32 * 64 * 4], &changed[..32 * 64 * 4]);
    assert!(!reference.matches(&frame(&changed)));
}

#[test]
fn image_freshness_characterization_new_frame_id_has_no_element_identity() {
    let before = frame(&vec![255; 64 * 64 * 4]);
    let reference = ImageReference::from_image(&before).unwrap();
    let mut after = before.clone();
    after.image_id = "image-after".into();
    // A newly captured frame with identical appearance is accepted.
    // This does NOT simulate or prove detection of an actual AX element replacement:
    // ComputerImage has no element-identity field to represent that difference.
    assert!(reference.matches(&after));
    assert!(reference.addresses("image-after", 2, 2).is_err());
}

#[test]
fn image_freshness_characterization_identity_geometry_and_bounds_remain_strict() {
    let before = frame(&vec![255; 64 * 64 * 4]);
    let reference = ImageReference::from_image(&before).unwrap();
    let mut after = before.clone();
    after.pid += 1;
    assert!(!reference.matches(&after));
    after = before.clone();
    after.window_id += 1;
    assert!(!reference.matches(&after));
    after = before.clone();
    after.geometry.desktop_x += 1.0;
    assert!(!reference.matches(&after));
    assert!(reference.addresses("image-before", 64, 2).is_err());
    assert!(reference.addresses("image-before", 2, 64).is_err());
}
```

