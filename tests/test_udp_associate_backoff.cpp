// 回归测试在 Release 构建下也必须执行断言。
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>

#include "network/UdpAssociateBackoff.hpp"

int main() {
    Network::UdpAssociateBackoff backoff(60000);

    // 初始不退避
    assert(!backoff.ShouldSkip(1000));

    // 首次失败：开启窗口，并要求输出一次提示
    assert(backoff.RecordFailure(1000));
    assert(backoff.ShouldSkip(1000));
    assert(backoff.ShouldSkip(60999));

    // 窗口内再次失败（并发 socket 已在途）：不重复提示，但延长窗口
    assert(!backoff.RecordFailure(30000));
    assert(backoff.ShouldSkip(89999));

    // 窗口到期后允许重试；再次失败视为新窗口，重新提示一次
    assert(!backoff.ShouldSkip(90000));
    assert(backoff.RecordFailure(90000));

    // 成功后立即结束退避（用户开启了代理软件的 UDP）
    backoff.RecordSuccess();
    assert(!backoff.ShouldSkip(90001));
    assert(backoff.RecordFailure(90002));
    return 0;
}
