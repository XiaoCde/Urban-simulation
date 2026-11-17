# -*-coding:utf-8 -*-
# python 3.9
# 绘制BCR的柱状图

"""
# @File       : 15_CBA_CBR.py
# @software   : PyCharm  
# @Time       ：2025/5/15 21:36
# @Author     ：Wei Lyu
"""
import pandas as pd
import matplotlib.pyplot as plt
plt.rcParams['pdf.fonttype'] = 42

if __name__ == '__main__':
    path = 'D:/LW/ABM/OutputData/Result/cities_21_max/Inflow/sigma=1/NumPerShelter/'

    # 读取数据
    df = pd.read_csv(path + 'scenarios_trues.csv', header=0)

    # 提取城市与 priority=0.3 的 BCR 列
    cities = df['City']
    bcr_values = df['priority0.3_BCR']

    # 计算平均值
    bcr_mean = bcr_values.mean()

    # 绘制柱状图
    plt.figure(figsize=(6, 4))
    bars = plt.bar(cities, bcr_values, color='#35316E', alpha=0.5, edgecolor='k', linewidth=1) #6496BB

    # y轴起点设置为15
    plt.ylim(25, max(bcr_values) * 1.05)

    # 平均线
    plt.axhline(y=bcr_mean, color='gray', linestyle='--', linewidth=1)
    plt.text(x=len(cities) - 1, y=bcr_mean + 0.5, s=f"Mean = {bcr_mean:.1f}", color='k',
             ha='right', va='bottom', fontsize=10)

    ax = plt.gca()
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)

    plt.xlabel("City")
    plt.ylabel("Benefit-Cost Ratio (BCR)")
    plt.title("Priority = 0.3 Scenario: BCR by City")
    plt.xticks(rotation=45, ha='right')
    plt.tight_layout()
    plt.savefig(r'D:\LW\ABM\OutputData\Result\pic\sigma=1\Inflow\NumPerShelter\CBA_priority0.3_CBR.pdf')
    plt.show()

