# TaiKeHoaDon

Tải hóa đơn điện tử từ **hoadondientu.gdt.gov.vn** (mua vào và bán ra) và xuất **bảng kê Excel theo tháng**,
có kiểm tra trạng thái hóa đơn, tổng hợp thuế suất và cảnh báo.

Tool không lưu mật khẩu, không vượt captcha: bạn tự đăng nhập trong cửa sổ trình duyệt do tool mở;
tool chỉ lặp lại thao tác bạn vẫn làm bằng tay (tìm kiếm → chọn hóa đơn → **Xuất xml**).

## Cài đặt

Cần Node.js 18+ và Microsoft Edge (hoặc Google Chrome). Bấm đúp **`TaiKeHoaDon.bat`** —
lần đầu tool tự cài thư viện (`npm install`).

## Nhiều công ty

Mở `TaiKeHoaDon.bat` → **chọn công ty** trong danh sách, hoặc **T** để khai báo công ty mới
(MST 10 số, chi nhánh 10 số-3 số; tên có thể để trống, tool tự lấy từ hóa đơn).
Danh sách lưu trong `cong_ty.json`. Mỗi công ty có thư mục và trình duyệt riêng nên không bị lẫn:

| Thư mục | Nội dung |
|---|---|
| `input/<MST>/mua-vao`, `input/<MST>/ban-ra` | File hóa đơn tải về: `MSTngườibán_KýhiệuMẫusốKýhiệu_Số.zip` |
| `input/<MST>/*/_trang_thai.json` | Trạng thái hóa đơn đọc từ bảng tra cứu (hủy, thay thế, điều chỉnh, bất hợp pháp, ủy nhiệm) |
| `ket_qua/<MST>/` | Bảng kê: `bang_ke_mua_ban_T09-2026_<ngày>_<giờ>.xlsx` |
| `logs/<MST>/` | Nhật ký mỗi lần chạy |
| `.browser-profiles/<MST>/` | Trình duyệt riêng của công ty (giữ phiên đăng nhập) |
| `input/_khac_cong_ty/` | File tải về nhưng không thuộc công ty đang chọn (đăng nhập nhầm tài khoản) |

**Chống lẫn dữ liệu:** mỗi file tải về được kiểm tra — mua vào thì *người mua*, bán ra thì *người bán*
phải đúng MST công ty đang chọn. Sai (đăng nhập nhầm tài khoản) thì tool **dừng ngay**, file đó được
chuyển vào `input/_khac_cong_ty/`. Khi xuất bảng kê, hóa đơn không thuộc công ty cũng bị bỏ qua và báo lại.

**Xóa công ty:** ở màn hình chọn công ty, chọn **X** → chọn công ty → gõ lại MST để xác nhận:
- *Chỉ xóa khỏi danh sách*: giữ nguyên dữ liệu; khai báo lại MST đó là dùng tiếp được.
- *Xóa và cất dữ liệu*: chuyển hóa đơn, bảng kê, nhật ký, trình duyệt của công ty vào
  `da_xoa/<MST>_<ngày giờ>/` (khôi phục bằng cách chép lại). Tool không xóa vĩnh viễn dữ liệu.

Lần đầu mở menu, nếu còn dữ liệu kiểu cũ (`input/mua-vao`, `input/ban-ra`), tool hỏi để chuyển vào
thư mục của đúng công ty (xác định MST từ hóa đơn).

## Menu của công ty

| Chọn | Việc |
|---|---|
| 1 | **Tải tự động**: nhập khoảng ngày + loại hóa đơn, tool tự tìm kiếm và tải hết |
| 2 | **Tải thủ công**: bạn tự tìm kiếm trên trang, nhấn Enter để tool tải danh sách đang hiện |
| 3 | Xuất bảng kê Excel từ các hóa đơn đã tải |
| 4 | Chia file XML/zip tải tay (bỏ vào `input/<MST>/`) vào đúng mua vào / bán ra |
| 5, 6, 7 | Mở thư mục bảng kê / hóa đơn / nhật ký |
| 9 | Đổi công ty |

### Tải tự động

1. Chọn **1** → cửa sổ Edge của công ty mở ra → **đăng nhập đúng tài khoản công ty đó** (tự gõ captcha).
2. Ở cửa sổ đen: nhập *Từ ngày*, *Đến ngày* (dd/mm/yyyy) và loại (mua vào / bán ra / cả hai) —
   làm trước hay sau khi đăng nhập đều được. **Không cần chuyển trang hay nhấn gì thêm**: tool tự nhận biết
   khi bạn đăng nhập xong (cookie đăng nhập của cổng thuế), tự mở
   `https://hoadondientu.gdt.gov.vn/tra-cuu/tra-cuu-hoa-don` rồi tải. Phiên đăng nhập cũ còn hạn thì vào
   thẳng; hết hạn thì tool báo và chờ bạn đăng nhập lại.
3. Tool chia khoảng ngày theo tháng (tối đa 30 ngày/lần) và tìm lần lượt:
   - **Mua vào** — 6 lần cho mỗi khoảng ngày:

     | Kết quả kiểm tra | Hóa đơn ủy nhiệm | Tab con |
     |---|---|---|
     | Đã cấp mã hóa đơn | không / **có** tick | HĐ điện tử + Máy tính tiền (có tick: chỉ HĐ điện tử) |
     | Cục Thuế đã nhận không mã | không / **có** tick | như trên |
     | Cục Thuế đã nhận HĐ có mã khởi tạo từ máy tính tiền | không / **có** tick | như trên |

     Xong thì bỏ tick ô ủy nhiệm. Hóa đơn ủy nhiệm ghi chung sheet mua vào, cột trạng thái có "(ủy nhiệm)".
   - **Bán ra**: *Tất cả*, ở cả 2 tab con.
   - Chọn 50 dòng/trang khi có hơn 15 kết quả.
4. Xong thì tool tự xuất bảng kê.

Hóa đơn đã tải sẽ được bỏ qua; hóa đơn lỗi (cổng thuế quá tải, "Cassandra timeout"…) được bỏ qua và
liệt kê cuối lượt — **chạy lại cùng khoảng ngày để tải bù**. Nếu trang thuế đổi giao diện làm chế độ
tự động không chạy được, dùng chế độ thủ công.

Mẫu định dạng bảng kê: `mau/bang_ke_mau.xlsx` (đặt file mẫu riêng vào `hoadon/bang_ke_mua_ban.xlsx` để dùng thay).

## Bảng kê (mỗi tháng 1 file, theo ngày lập)

| Sheet | Nội dung |
|---|---|
| `T09` (tháng) và `Total` | Hóa đơn mua vào của tháng, mỗi dòng hàng hóa 1 dòng |
| `Bán ra` | Hóa đơn bán ra của tháng (giữ công thức cột M, Q, R như mẫu) |
| `Kiểm tra` | Đối chiếu số lượng, tổng hợp theo thuế suất, cảnh báo |

- Cột **Trạng thái HĐ** (mua vào: cột P, bán ra: cột S). Hóa đơn **đã bị hủy / đã bị thay thế** tô đỏ và
  **không cộng** vào dòng TỔNG CỘNG (công thức `SUMIFS`); hóa đơn điều chỉnh tô vàng; "Bất hợp pháp" tô đỏ.
- Chạy lại: mở file mới nhất của tháng đó, chỉ thêm hóa đơn chưa có và cập nhật trạng thái, lưu thành
  file mới. Tháng không có gì thay đổi thì không tạo file. Chỉnh sửa tay trong file được giữ lại.

### Sheet Kiểm tra

1. **Số lượng**: cổng thuế báo / đã có file / chưa tải được (chỉ có số cổng thuế khi tải tự động).
2. **Tổng hợp theo thuế suất** (0%, 5%, 8%, 10%, KCT…): tiền hàng, tiền thuế mua vào và bán ra —
   không tính hóa đơn đã hủy / bị thay thế — để đối chiếu với tờ khai 01/GTGT.
3. **Cảnh báo**: hóa đơn hủy / thay thế / điều chỉnh, hóa đơn bị đánh dấu *Bất hợp pháp*, hóa đơn mua vào
   từ **5 triệu đồng** thanh toán tiền mặt (Luật Thuế GTGT 2024 — đổi `CASH_LIMIT` trong `lib/bangke.js`
   nếu quy định thay đổi), hóa đơn có trên cổng thuế nhưng chưa tải được.

## Code

| File | Việc |
|---|---|
| `menu.js` | Menu: chọn / khai báo công ty, chuyển dữ liệu kiểu cũ |
| `lib/company.js` | Danh sách công ty, thư mục riêng của từng công ty |
| `download.js` | Mở trình duyệt của công ty, chế độ tự động / thủ công, rồi xuất bảng kê |
| `lib/auto.js` | Tự chọn tab, nhập ngày, chọn "Kết quả kiểm tra", Tìm kiếm, 50 dòng/trang |
| `lib/portal.js` | Thao tác trên bảng: chọn dòng, Xuất xml, chuyển trang, nhận file về muộn |
| `lib/reader.js` | Đọc XML hóa đơn (chuẩn TT78) từ .xml / .zip |
| `lib/status.js` | Lưu / tra trạng thái hóa đơn |
| `lib/bangke.js`, `bang-ke.js` | Xuất bảng kê theo mẫu + sheet Kiểm tra |
| `sap-xep.js` | Chia file tải tay vào `mua-vao` / `ban-ra` |
